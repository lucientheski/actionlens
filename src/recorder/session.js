import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

/**
 * Records step execution results for replay and analysis.
 * Captures timing, outputs, exit codes, and logs for each step.
 */
export class SessionRecorder {
  /**
   * @param {object} [options]
   * @param {string} [options.outputDir] - Directory to save recordings
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir || '.actionlens/recordings';
    this.session = {
      id: generateSessionId(),
      startedAt: new Date().toISOString(),
      workflow: null,
      jobs: {},
    };
  }

  /**
   * Set the workflow being recorded.
   *
   * @param {object} workflow - Parsed workflow object
   */
  setWorkflow(workflow) {
    this.session.workflow = {
      name: workflow.name,
      jobs: Object.keys(workflow.jobs),
    };
  }

  /**
   * Record the start of a job.
   *
   * @param {string} jobId
   */
  startJob(jobId) {
    this.session.jobs[jobId] = {
      startedAt: new Date().toISOString(),
      completedAt: null,
      steps: [],
      success: null,
    };
  }

  /**
   * Record a step result.
   *
   * @param {string} jobId
   * @param {object} step - The step definition
   * @param {object} result - Execution result
   */
  recordStep(jobId, step, result) {
    if (!this.session.jobs[jobId]) {
      this.startJob(jobId);
    }

    this.session.jobs[jobId].steps.push({
      index: step.index,
      name: step.name,
      uses: step.uses,
      run: step.run ? step.run.slice(0, 200) : null,
      exitCode: result.exitCode,
      success: result.success,
      skipped: result.skipped || false,
      stdout: result.stdout?.slice(0, 10000) || '',
      stderr: result.stderr?.slice(0, 5000) || '',
      outputs: result.outputs || {},
      recordedAt: new Date().toISOString(),
    });
  }

  /**
   * Mark a job as completed.
   *
   * @param {string} jobId
   * @param {boolean} success
   */
  completeJob(jobId, success) {
    if (this.session.jobs[jobId]) {
      this.session.jobs[jobId].completedAt = new Date().toISOString();
      this.session.jobs[jobId].success = success;
    }
  }

  /**
   * Save the recording to disk.
   *
   * @returns {string} Path to the saved recording
   */
  save() {
    this.session.completedAt = new Date().toISOString();

    const dir = resolve(this.outputDir);
    mkdirSync(dir, { recursive: true });

    const filePath = resolve(dir, `${this.session.id}.json`);
    writeFileSync(filePath, JSON.stringify(this.session, null, 2), 'utf-8');

    return filePath;
  }

  /**
   * Load a previously saved recording.
   *
   * @param {string} filePath - Path to the recording JSON
   * @returns {object} Session data
   */
  static load(filePath) {
    const absPath = resolve(filePath);
    if (!existsSync(absPath)) {
      throw new Error(`Recording not found: ${absPath}`);
    }
    return JSON.parse(readFileSync(absPath, 'utf-8'));
  }
}

/**
 * Generate a short session ID based on timestamp and random suffix.
 */
function generateSessionId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `session-${ts}-${rand}`;
}
