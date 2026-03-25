import { EventEmitter } from 'node:events';
import { evaluateExpression, createExpressionContext } from '../parser/expressions.js';
import { DockerRunner } from './docker.js';
import { StepRunner } from './step.js';
import { ActionRunner } from './actions.js';

/**
 * Top-level orchestrator that ties parsing, Docker, step execution,
 * and job dependencies together into a complete pipeline run.
 *
 * Emits events that the TUI controller can consume to drive the UI.
 */
export class Pipeline extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.workflow - Parsed workflow from parseWorkflow()
   * @param {object} [options.secrets] - Secret values
   * @param {object} [options.github] - GitHub context overrides
   * @param {object} [options.dockerOptions] - Options passed to DockerRunner
   * @param {string} [options.actionsCacheDir] - Cache directory for cloned actions
   * @param {boolean} [options.interactive] - If true, yield control between steps for TUI
   */
  constructor(options) {
    super();
    this.workflow = options.workflow;
    this.secrets = options.secrets || {};
    this.github = options.github || {
      event_name: 'workflow_dispatch',
      repository: process.cwd(),
      ref: 'refs/heads/main',
      sha: 'local',
      workspace: '/github/workspace',
    };
    this.dockerOptions = options.dockerOptions || {};
    this.actionsCacheDir = options.actionsCacheDir;
    this.interactive = options.interactive !== false;

    // Runtime state
    this.containers = new Map(); // jobId → DockerRunner
    this.jobOutputs = {};        // jobId → { outputName: value }
    this.jobResults = {};        // jobId → { success, outputs }
    this._aborted = false;
    this._cleanupHandlers = [];
  }

  /**
   * Run the entire workflow — resolve job dependencies and execute in order.
   * Returns a map of jobId → result.
   */
  async run() {
    this._registerCleanupHandlers();

    try {
      const executionOrder = this._resolveJobOrder();
      this.emit('pipeline:start', { jobs: executionOrder });

      for (const jobId of executionOrder) {
        if (this._aborted) break;

        const job = this.workflow.jobs[jobId];
        const result = await this._runJob(jobId, job);
        this.jobResults[jobId] = result;

        if (!result.success && !this._isFailureAllowed(job)) {
          this.emit('pipeline:job-failed', { jobId, result });
          // Don't run dependent jobs, but continue independent ones
        }
      }

      this.emit('pipeline:done', { results: this.jobResults });
      return this.jobResults;
    } finally {
      await this._cleanupAll();
      this._unregisterCleanupHandlers();
    }
  }

  /**
   * Run a single job — creates container, executes steps, collects outputs.
   *
   * @param {string} jobId
   * @param {object} job - Normalized job
   * @returns {{ success: boolean, outputs: object, stepResults: object[] }}
   */
  async _runJob(jobId, job) {
    // Check if dependencies succeeded
    for (const dep of job.needs || []) {
      const depResult = this.jobResults[dep];
      if (!depResult || !depResult.success) {
        this.emit('job:skipped', { jobId, reason: `dependency '${dep}' failed or not run` });
        return { success: false, outputs: {}, stepResults: [], skipped: true };
      }
    }

    // Evaluate job-level if: condition
    if (job.if) {
      const context = this._buildJobContext(jobId, job);
      const condition = evaluateExpression(job.if, context);
      if (condition === 'false' || condition === '' || condition === '0') {
        this.emit('job:skipped', { jobId, reason: `if condition evaluated to false` });
        return { success: true, outputs: {}, stepResults: [], skipped: true };
      }
    }

    this.emit('job:start', { jobId, job });

    // Create Docker container for this job
    const docker = new DockerRunner(this.dockerOptions);
    this.containers.set(jobId, docker);

    const image = this._resolveImage(job.runsOn);

    try {
      await docker.createContainer({
        image,
        env: { ...this.workflow.env, ...job.env },
        onProgress: (progress) => {
          this.emit('docker:progress', { jobId, ...progress });
        },
      });
    } catch (err) {
      this.emit('job:error', { jobId, error: err });
      return { success: false, outputs: {}, stepResults: [], error: err.message };
    }

    // Build expression context for this job
    const expressionContext = this._buildJobContext(jobId, job);

    // Create runners
    const actionRunner = new ActionRunner(docker, {
      cacheDir: this.actionsCacheDir,
    });
    const stepRunner = new StepRunner(docker, expressionContext, {
      jobEnv: job.env || {},
      workflowEnv: this.workflow.env || {},
      actionRunner,
    });

    // Execute steps sequentially
    const stepResults = [];
    let jobSuccess = true;

    for (let i = 0; i < job.steps.length; i++) {
      if (this._aborted) break;

      const step = job.steps[i];
      this.emit('step:start', { jobId, index: i, step });

      // In interactive mode, yield control and wait for TUI to tell us to proceed
      if (this.interactive) {
        const action = await this._yieldToController(jobId, i, step);
        if (action === 'skip') {
          stepResults.push({ success: true, skipped: true, outputs: {} });
          this.emit('step:skip', { jobId, index: i, step });
          continue;
        }
        if (action === 'abort') {
          this._aborted = true;
          break;
        }
        // action === 'run' — proceed
      }

      try {
        const result = await stepRunner.run(step, {
          onStdout: (chunk) => this.emit('step:stdout', { jobId, index: i, chunk }),
          onStderr: (chunk) => this.emit('step:stderr', { jobId, index: i, chunk }),
        });

        stepResults.push(result);

        // Update expression context with step outputs
        if (step.id && result.outputs) {
          expressionContext.steps[step.id] = { outputs: result.outputs };
        }

        this.emit('step:end', { jobId, index: i, step, result });

        if (!result.success && !result.skipped) {
          jobSuccess = false;
          if (step.continueOnError !== true) {
            break; // Stop job on first failure unless continue-on-error
          }
        }
      } catch (err) {
        const errorResult = {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: err.message,
          outputs: {},
          skipped: false,
        };
        stepResults.push(errorResult);
        this.emit('step:error', { jobId, index: i, step, error: err });
        jobSuccess = false;
        break;
      }
    }

    // Collect job outputs
    const outputs = this._collectJobOutputs(job, expressionContext);
    this.jobOutputs[jobId] = outputs;

    this.emit('job:end', { jobId, success: jobSuccess, outputs });

    return { success: jobSuccess, outputs, stepResults };
  }

  /**
   * Resolve job execution order using topological sort on `needs:` dependencies.
   * Throws if there's a circular dependency.
   */
  _resolveJobOrder() {
    const jobs = this.workflow.jobs;
    const jobIds = Object.keys(jobs);
    const visited = new Set();
    const visiting = new Set();
    const order = [];

    const visit = (id) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Circular dependency detected involving job '${id}'`);
      }
      visiting.add(id);

      const job = jobs[id];
      for (const dep of job.needs || []) {
        if (!jobs[dep]) {
          throw new Error(`Job '${id}' depends on unknown job '${dep}'`);
        }
        visit(dep);
      }

      visiting.delete(id);
      visited.add(id);
      order.push(id);
    };

    for (const id of jobIds) {
      visit(id);
    }

    return order;
  }

  /**
   * Build expression context for a job, including outputs from dependency jobs.
   */
  _buildJobContext(jobId, job) {
    const needs = {};
    for (const dep of job.needs || []) {
      needs[dep] = {
        outputs: this.jobOutputs[dep] || {},
        result: this.jobResults[dep]?.success ? 'success' : 'failure',
      };
    }

    return createExpressionContext({
      env: { ...this.workflow.env, ...job.env },
      secrets: this.secrets,
      github: this.github,
      steps: {},
      inputs: {},
      matrix: {},
      needs,
    });
  }

  /**
   * Map runs-on labels to Docker images.
   */
  _resolveImage(runsOn) {
    const imageMap = {
      'ubuntu-latest': 'ubuntu:22.04',
      'ubuntu-22.04': 'ubuntu:22.04',
      'ubuntu-20.04': 'ubuntu:20.04',
      'ubuntu-24.04': 'ubuntu:24.04',
    };
    return imageMap[runsOn] || this.dockerOptions.image || 'ubuntu:22.04';
  }

  /**
   * Yield control to an external controller (TUI) between steps.
   * Returns 'run', 'skip', or 'abort'.
   */
  _yieldToController(jobId, index, step) {
    return new Promise((resolve) => {
      this.emit('pipeline:yield', {
        jobId,
        index,
        step,
        resume: (action) => resolve(action || 'run'),
      });

      // If no listener picks this up within a tick, auto-run
      setImmediate(() => {
        if (!this.listenerCount('pipeline:yield')) {
          resolve('run');
        }
      });
    });
  }

  /**
   * Collect job-level outputs from the expression context.
   */
  _collectJobOutputs(job, context) {
    const outputs = {};
    if (job.outputs) {
      for (const [name, expr] of Object.entries(job.outputs)) {
        outputs[name] = evaluateExpression(String(expr), context);
      }
    }
    return outputs;
  }

  /**
   * Check if job failure is allowed (e.g., continue-on-error at job level).
   */
  _isFailureAllowed(job) {
    return job.continueOnError === true;
  }

  /**
   * Abort the pipeline.
   */
  abort() {
    this._aborted = true;
    this.emit('pipeline:abort');
  }

  /**
   * Get the DockerRunner for a specific job (for interactive shell access).
   */
  getJobDocker(jobId) {
    return this.containers.get(jobId);
  }

  /**
   * Cleanup all containers.
   */
  async _cleanupAll() {
    const cleanups = [];
    for (const [jobId, docker] of this.containers) {
      cleanups.push(
        docker.cleanup().catch((err) => {
          this.emit('cleanup:error', { jobId, error: err });
        })
      );
    }
    await Promise.all(cleanups);
    this.containers.clear();
  }

  /**
   * Register process signal handlers for graceful cleanup.
   */
  _registerCleanupHandlers() {
    const handler = async () => {
      this._aborted = true;
      await this._cleanupAll();
      process.exit(1);
    };

    this._sigintHandler = handler;
    this._sigtermHandler = handler;

    process.on('SIGINT', this._sigintHandler);
    process.on('SIGTERM', this._sigtermHandler);
  }

  /**
   * Remove process signal handlers.
   */
  _unregisterCleanupHandlers() {
    if (this._sigintHandler) process.off('SIGINT', this._sigintHandler);
    if (this._sigtermHandler) process.off('SIGTERM', this._sigtermHandler);
  }
}
