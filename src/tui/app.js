import blessed from 'blessed';
import { spawn } from 'node:child_process';
import { Controller, State } from './controller.js';
import { createStepPanel } from './panels/steps.js';
import { createOutputPanel } from './panels/output.js';
import { createStatusBar } from './panels/status.js';

/**
 * Main TUI debugger application.
 * Creates blessed screen, wires panels, handles lifecycle.
 */
export class DebuggerApp {
  /**
   * @param {object} options
   * @param {object} options.job - Normalized job from parser
   * @param {object} [options.dockerRunner]
   * @param {object} [options.stepRunner]
   * @param {object} [options.actionRunner]
   * @param {object} [options.recorder]
   * @param {object} [options.expressionContext]
   */
  constructor(options) {
    this.controller = new Controller(options);
    this.screen = null;
    this.panels = {};
    this.focusIndex = 0;
    this.focusable = [];
  }

  /** Launch the TUI. */
  async run() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: `ActionLens — ${this.controller.jobName}`,
      fullUnicode: true,
    });

    this._createPanels();
    this._bindKeys();
    this.controller.start();
    this.screen.render();

    // Return a promise that resolves when the user quits
    return new Promise((resolve) => {
      this._resolve = resolve;
    });
  }

  _createPanels() {
    this.panels.steps = createStepPanel(this.screen, this.controller);
    this.panels.output = createOutputPanel(this.screen, this.controller);
    const { bar, commandBar } = createStatusBar(this.screen, this.controller);
    this.panels.statusBar = bar;
    this.panels.commandBar = commandBar;

    this.focusable = [this.panels.steps, this.panels.output];
    this.panels.steps.focus();
  }

  _bindKeys() {
    const screen = this.screen;
    const ctrl = this.controller;

    // Navigation
    screen.key(['up', 'k'], () => ctrl.selectPrev());
    screen.key(['down', 'j'], () => ctrl.selectNext());

    // Tab — switch focus between panels
    screen.key('tab', () => {
      this.focusIndex = (this.focusIndex + 1) % this.focusable.length;
      this.focusable[this.focusIndex].focus();
      screen.render();
    });

    // R — Run current step
    screen.key('r', () => {
      if (ctrl.state === State.WAITING) {
        ctrl.runStep();
      }
    });

    // S — Skip current step
    screen.key('s', () => ctrl.skipStep());

    // B — Toggle breakpoint
    screen.key('b', () => ctrl.toggleBreakpoint());

    // N — Auto-run to next breakpoint
    screen.key('n', () => {
      if (ctrl.state === State.WAITING) {
        ctrl.runToBreakpoint();
      }
    });

    // A — Auto-run all remaining
    screen.key('a', () => {
      if (ctrl.state === State.WAITING) {
        ctrl.runAll();
      }
    });

    // I — Shell into container
    screen.key('i', () => this._shellInto());

    // E — Edit env vars
    screen.key('e', () => this._editEnv());

    // V — View variables
    screen.key('v', () => this._showVariables());

    // Q — Quit
    screen.key(['q', 'C-c'], () => this._quit());
  }

  async _shellInto() {
    const ctrl = this.controller;
    if (ctrl.state !== State.WAITING) return;

    if (!ctrl.dockerRunner || !ctrl.dockerRunner.container) {
      ctrl.emit('output', '\n{red-fg}[No container available — run a step first]{/red-fg}\n');
      this.screen.render();
      return;
    }

    ctrl._setState(State.SHELL);
    this.screen.destroy();

    // Spawn interactive bash in the container
    const containerId = ctrl.dockerRunner.container.id;
    const shell = spawn('docker', ['exec', '-it', containerId, 'bash'], {
      stdio: 'inherit',
    });

    shell.on('close', () => {
      ctrl.shellDone();
      // Re-create the screen
      this.screen = blessed.screen({
        smartCSR: true,
        title: `ActionLens — ${ctrl.jobName}`,
        fullUnicode: true,
      });
      this._createPanels();
      this._bindKeys();
      this.screen.render();
    });
  }

  _editEnv() {
    const ctrl = this.controller;
    if (ctrl.state !== State.WAITING) return;

    const step = ctrl.currentStep;
    if (!step) return;

    // Show env vars in a popup
    const envText = Object.entries(step.env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') || '(no step-level env vars)';

    const popup = blessed.box({
      parent: this.screen,
      label: ' Environment Variables ',
      top: 'center',
      left: 'center',
      width: '60%',
      height: '50%',
      border: { type: 'line' },
      style: {
        border: { fg: 'yellow' },
        label: { fg: 'yellow', bold: true },
        fg: 'white',
      },
      content: envText + '\n\n{gray-fg}Press Escape to close{/gray-fg}',
      tags: true,
      scrollable: true,
      focusable: true,
    });

    popup.focus();
    popup.key('escape', () => {
      popup.destroy();
      this.screen.render();
    });
    this.screen.render();
  }

  _showVariables() {
    const ctrl = this.controller;
    if (ctrl.state !== State.WAITING && ctrl.state !== State.DONE) return;

    const vars = ctrl.getVariables();
    const lines = [];

    lines.push('{bold}Environment:{/bold}');
    for (const [k, v] of Object.entries(vars.env)) {
      lines.push(`  ${k}=${v}`);
    }
    if (Object.keys(vars.env).length === 0) lines.push('  (none)');

    lines.push('\n{bold}Secrets:{/bold} (names only)');
    for (const k of vars.secrets) {
      lines.push(`  ${k}=***`);
    }
    if (vars.secrets.length === 0) lines.push('  (none)');

    lines.push('\n{bold}GitHub Context:{/bold}');
    for (const [k, v] of Object.entries(vars.github)) {
      lines.push(`  ${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    if (Object.keys(vars.github).length === 0) lines.push('  (none)');

    lines.push('\n{bold}Step Outputs:{/bold}');
    for (const [id, data] of Object.entries(vars.steps)) {
      lines.push(`  ${id}:`);
      for (const [k, v] of Object.entries(data.outputs || {})) {
        lines.push(`    ${k}=${v}`);
      }
    }
    if (Object.keys(vars.steps).length === 0) lines.push('  (none)');

    const popup = blessed.box({
      parent: this.screen,
      label: ' Expression Variables ',
      top: 'center',
      left: 'center',
      width: '70%',
      height: '60%',
      border: { type: 'line' },
      style: {
        border: { fg: 'green' },
        label: { fg: 'green', bold: true },
        fg: 'white',
      },
      content: lines.join('\n') + '\n\n{gray-fg}Press Escape to close{/gray-fg}',
      tags: true,
      scrollable: true,
      focusable: true,
    });

    popup.focus();
    popup.key('escape', () => {
      popup.destroy();
      this.screen.render();
    });
    this.screen.render();
  }

  async _quit() {
    await this.controller.cleanup();
    this.screen.destroy();
    if (this._resolve) this._resolve();
  }
}
