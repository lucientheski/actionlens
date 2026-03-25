import chalk from 'chalk';

/**
 * Terminal UI for interactive debugging.
 * Phase 1: minimal text-based interface.
 * Phase 2: full TUI with ink or blessed.
 */
export class DebuggerUI {
  constructor() {
    this.currentJob = null;
    this.currentStep = 0;
    this.breakpoints = new Set();
    this.paused = false;
  }

  /**
   * Display the workflow overview.
   *
   * @param {object} workflow - Parsed workflow
   */
  showWorkflow(workflow) {
    console.log(chalk.bold.cyan(`\n━━━ ActionLens Debugger ━━━\n`));
    console.log(chalk.dim(`Workflow: ${workflow.name}`));
    console.log(chalk.dim(`Jobs: ${Object.keys(workflow.jobs).join(', ')}\n`));
  }

  /**
   * Display step execution status.
   *
   * @param {object} step - Step being executed
   * @param {'running'|'success'|'failure'|'skipped'} status
   * @param {object} [result] - Step result
   */
  showStep(step, status, result = null) {
    const num = step.index + 1;
    const label = step.name || step.run?.slice(0, 60) || step.uses || 'unnamed';

    const icons = {
      running: chalk.yellow('▶'),
      success: chalk.green('✓'),
      failure: chalk.red('✗'),
      skipped: chalk.dim('○'),
    };

    const icon = icons[status] || '?';
    console.log(`  ${icon} Step ${num}: ${label}`);

    if (result?.stderr && status === 'failure') {
      console.log(chalk.red(`    ${result.stderr.split('\n')[0]}`));
    }
  }

  /**
   * Set breakpoints at specific step numbers (1-based).
   *
   * @param {number[]} steps
   */
  setBreakpoints(steps) {
    this.breakpoints = new Set(steps);
  }

  /**
   * Check if execution should pause at this step.
   *
   * @param {number} stepIndex - 0-based step index
   * @returns {boolean}
   */
  shouldPause(stepIndex) {
    return this.breakpoints.has(stepIndex + 1);
  }
}
