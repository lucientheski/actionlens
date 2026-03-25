import { EventEmitter } from 'node:events';
import { createExpressionContext, evaluateExpression } from '../parser/expressions.js';

/**
 * Debugger state machine — bridges TUI events with runner execution.
 * Testable without blessed or a real terminal.
 *
 * States: IDLE → WAITING → RUNNING → WAITING (loop) → DONE
 *                                  → SHELL (interactive) → WAITING
 */

export const State = {
  IDLE: 'IDLE',
  WAITING: 'WAITING',
  RUNNING: 'RUNNING',
  SHELL: 'SHELL',
  DONE: 'DONE',
};

export const StepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

export class Controller extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.job - Normalized job from parser
   * @param {object} [options.dockerRunner] - DockerRunner instance
   * @param {object} [options.stepRunner] - StepRunner instance
   * @param {object} [options.actionRunner] - ActionRunner instance
   * @param {object} [options.recorder] - SessionRecorder instance
   * @param {object} [options.expressionContext] - Expression context
   */
  constructor({ job, dockerRunner, stepRunner, actionRunner, recorder, expressionContext }) {
    super();
    this.job = job;
    this.dockerRunner = dockerRunner;
    this.stepRunner = stepRunner;
    this.actionRunner = actionRunner;
    this.recorder = recorder;
    this.expressionContext = expressionContext || createExpressionContext();

    this.state = State.IDLE;
    this.selectedIndex = 0;
    this.steps = job.steps.map((step) => ({
      ...step,
      status: StepStatus.PENDING,
      result: null,
    }));
    this.breakpoints = new Set();
    this.autoRunMode = false; // 'all' | 'breakpoint' | false
  }

  get currentStep() {
    return this.steps[this.selectedIndex];
  }

  get jobName() {
    return this.job.id || 'unknown';
  }

  get containerStatus() {
    return this.dockerRunner ? 'connected' : 'no-docker';
  }

  /** Transition to a new state, emitting event. */
  _setState(newState) {
    const old = this.state;
    this.state = newState;
    this.emit('state', { from: old, to: newState });
  }

  /**
   * Initialize the Docker container for step execution.
   * Pulls the image (with progress) and creates the container with workspace mounted.
   *
   * @param {object} [options]
   * @param {string} [options.workspacePath] - Host path to mount as /github/workspace
   * @param {string} [options.image] - Docker image to use
   */
  async initContainer(options = {}) {
    if (!this.dockerRunner) return;

    const runsOn = this.job.runsOn || 'ubuntu-latest';
    const imageMap = {
      'ubuntu-latest': 'ubuntu:22.04',
      'ubuntu-22.04': 'ubuntu:22.04',
      'ubuntu-20.04': 'ubuntu:20.04',
    };
    const image = options.image || imageMap[runsOn] || 'ubuntu:22.04';

    // Check Docker availability
    const available = await this.dockerRunner.isAvailable();
    if (!available) {
      throw new Error(
        'Docker is not running. Please start Docker and try again.\n' +
        'ActionLens requires Docker to execute workflow steps locally.'
      );
    }

    // Pull image with progress
    this.emit('output', `Pulling image ${image}...\n`);
    await this.dockerRunner.pullImage(image, {
      onProgress: ({ status, progress, id }) => {
        const line = id ? `  ${id}: ${status} ${progress}` : `  ${status}`;
        this.emit('pull:progress', line);
      },
    });
    this.emit('output', `Image ${image} ready.\n`);

    // Create container with workspace bind
    const binds = [];
    if (options.workspacePath) {
      binds.push(`${options.workspacePath}:/github/workspace`);
    }

    await this.dockerRunner.createContainer({
      image,
      env: { ...this.expressionContext.env },
      binds,
    });

    this.emit('output', 'Container started.\n');
  }

  /** Start the debugger — transition from IDLE to WAITING. */
  start() {
    if (this.state !== State.IDLE) return;
    this._setState(State.WAITING);
    this.emit('ready');
    this.emit('refresh');
  }

  /** Navigate step list up. */
  selectPrev() {
    if (this.state !== State.WAITING) return;
    if (this.selectedIndex > 0) {
      this.selectedIndex--;
      this.emit('select', this.selectedIndex);
      this.emit('refresh');
    }
  }

  /** Navigate step list down. */
  selectNext() {
    if (this.state !== State.WAITING) return;
    if (this.selectedIndex < this.steps.length - 1) {
      this.selectedIndex++;
      this.emit('select', this.selectedIndex);
      this.emit('refresh');
    }
  }

  /** Toggle breakpoint on the selected step. */
  toggleBreakpoint(index = this.selectedIndex) {
    if (this.breakpoints.has(index)) {
      this.breakpoints.delete(index);
    } else {
      this.breakpoints.add(index);
    }
    this.emit('breakpoint', { index, active: this.breakpoints.has(index) });
    this.emit('refresh');
  }

  /** Find the next step that hasn't been run yet. Returns -1 if all done. */
  _nextPendingIndex() {
    for (let i = 0; i < this.steps.length; i++) {
      if (this.steps[i].status === StepStatus.PENDING) return i;
    }
    return -1;
  }

  /** Run the currently selected step. */
  async runStep(index = this.selectedIndex) {
    if (this.state !== State.WAITING) return;
    if (index < 0 || index >= this.steps.length) return;

    const step = this.steps[index];
    if (step.status !== StepStatus.PENDING) return;

    this.selectedIndex = index;
    step.status = StepStatus.RUNNING;
    this._setState(State.RUNNING);
    this.emit('step:start', { index, step });
    this.emit('refresh');

    try {
      let result;
      if (this.stepRunner) {
        result = await this.stepRunner.run(step, {
          onStdout: (chunk) => this.emit('output', chunk),
          onStderr: (chunk) => this.emit('output', `{red-fg}${chunk}{/red-fg}`),
        });
      } else {
        // No runner — simulate for testing
        result = { success: true, exitCode: 0, stdout: '', stderr: '', outputs: {}, skipped: false };
      }

      if (result.skipped) {
        step.status = StepStatus.SKIPPED;
      } else if (result.success) {
        step.status = StepStatus.PASSED;
      } else {
        step.status = StepStatus.FAILED;
      }
      step.result = result;

      // Update expression context with step outputs
      if (step.id && result.outputs) {
        if (!this.expressionContext.steps) this.expressionContext.steps = {};
        this.expressionContext.steps[step.id] = { outputs: result.outputs };
      }

      if (this.recorder) {
        this.recorder.recordStep(this.job.id, step, result);
      }

      this.emit('step:end', { index, step, result });

      // Check if all steps are done
      const nextPending = this._nextPendingIndex();
      if (nextPending === -1) {
        this._setState(State.DONE);
        this.emit('done');
        this.emit('refresh');
        return;
      }

      this._setState(State.WAITING);
      this.emit('refresh');

      // Handle auto-run modes
      if (this.autoRunMode === 'all') {
        await this._autoRunNext(nextPending);
      } else if (this.autoRunMode === 'breakpoint') {
        if (this.breakpoints.has(nextPending)) {
          this.autoRunMode = false;
          this.selectedIndex = nextPending;
          this.emit('output', `\n[Breakpoint hit at step ${nextPending + 1}]\n`);
          this.emit('refresh');
        } else {
          await this._autoRunNext(nextPending);
        }
      }
    } catch (err) {
      step.status = StepStatus.FAILED;
      step.result = { success: false, exitCode: 1, stdout: '', stderr: err.message, outputs: {} };
      this.emit('step:error', { index, step, error: err });
      this._setState(State.WAITING);
      this.emit('refresh');
    }
  }

  async _autoRunNext(nextIndex) {
    this.selectedIndex = nextIndex;
    this.emit('refresh');
    // Use setImmediate to avoid deep recursion
    await new Promise((resolve) => setImmediate(resolve));
    await this.runStep(nextIndex);
  }

  /** Skip the currently selected step. */
  skipStep(index = this.selectedIndex) {
    if (this.state !== State.WAITING) return;
    const step = this.steps[index];
    if (!step || step.status !== StepStatus.PENDING) return;

    step.status = StepStatus.SKIPPED;
    step.result = { success: true, exitCode: 0, stdout: '', stderr: '', outputs: {}, skipped: true };
    this.emit('step:skip', { index, step });

    const nextPending = this._nextPendingIndex();
    if (nextPending === -1) {
      this._setState(State.DONE);
      this.emit('done');
    }
    this.emit('refresh');
  }

  /** Auto-run all remaining steps. */
  async runAll() {
    if (this.state !== State.WAITING) return;
    this.autoRunMode = 'all';
    const nextPending = this._nextPendingIndex();
    if (nextPending === -1) return;
    this.selectedIndex = nextPending;
    await this.runStep(nextPending);
  }

  /** Auto-run until next breakpoint. */
  async runToBreakpoint() {
    if (this.state !== State.WAITING) return;
    this.autoRunMode = 'breakpoint';
    const nextPending = this._nextPendingIndex();
    if (nextPending === -1) return;
    // If we're already at a breakpoint, skip past it
    this.selectedIndex = nextPending;
    await this.runStep(nextPending);
  }

  /** Enter interactive shell. */
  async shellInto() {
    if (this.state !== State.WAITING) return;
    if (!this.dockerRunner) {
      this.emit('output', '\n[No Docker runner available for shell]\n');
      return;
    }
    this._setState(State.SHELL);
    this.emit('shell:start');
    // The actual shell spawning is handled by the TUI app
    // which will call shellDone() when the user exits
  }

  /** Signal that the interactive shell session has ended. */
  shellDone() {
    if (this.state !== State.SHELL) return;
    this._setState(State.WAITING);
    this.emit('shell:end');
    this.emit('refresh');
  }

  /** Get the expression context for variable inspection. */
  getVariables() {
    return {
      env: this.expressionContext.env || {},
      secrets: Object.keys(this.expressionContext.secrets || {}),
      github: this.expressionContext.github || {},
      steps: this.expressionContext.steps || {},
      matrix: this.expressionContext.matrix || {},
    };
  }

  /** Clean up resources. */
  async cleanup() {
    if (this.dockerRunner) {
      try {
        await this.dockerRunner.cleanup();
      } catch {
        // best-effort cleanup
      }
    }
    this.emit('cleanup');
  }
}
