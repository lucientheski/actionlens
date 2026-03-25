import blessed from 'blessed';

/**
 * Output panel — shows stdout/stderr of the selected step in real-time.
 */
export function createOutputPanel(screen, controller) {
  const panel = blessed.log({
    parent: screen,
    label: ' Output ',
    top: 0,
    left: '35%',
    width: '65%',
    height: '100%-3',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      label: { fg: 'cyan', bold: true },
      fg: 'white',
    },
    scrollable: true,
    scrollbar: {
      style: { bg: 'blue' },
    },
    tags: true,
    focusable: true,
    mouse: true,
  });

  // Show output for the selected step
  function showStepOutput(step) {
    panel.setContent('');
    if (!step.result) {
      panel.log(`{gray-fg}Step ${step.index + 1}: ${step.name || step.run || step.uses || 'unnamed'}{/gray-fg}`);
      panel.log('{gray-fg}No output yet — press R to run{/gray-fg}');
      return;
    }

    const r = step.result;
    if (r.skipped) {
      panel.log('{gray-fg}[Step skipped]{/gray-fg}');
      return;
    }
    if (r.stdout) {
      panel.log(r.stdout);
    }
    if (r.stderr) {
      panel.log(`{red-fg}${r.stderr}{/red-fg}`);
    }
    if (!r.stdout && !r.stderr) {
      panel.log('{gray-fg}(no output){/gray-fg}');
    }
  }

  controller.on('refresh', () => {
    const step = controller.currentStep;
    if (step) showStepOutput(step);
  });

  controller.on('output', (text) => {
    panel.log(text);
    screen.render();
  });

  controller.on('step:start', ({ step }) => {
    panel.setContent('');
    panel.log(`{yellow-fg}Running step ${step.index + 1}: ${step.name || step.run || step.uses || ''}...{/yellow-fg}`);
    screen.render();
  });

  controller.on('step:end', ({ step, result }) => {
    panel.setContent('');
    if (result.stdout) panel.log(result.stdout);
    if (result.stderr) panel.log(`{red-fg}${result.stderr}{/red-fg}`);
    const tag = result.success ? '{green-fg}[PASSED]{/green-fg}' : '{red-fg}[FAILED]{/red-fg}';
    panel.log(`\n${tag} exit code: ${result.exitCode}`);
    screen.render();
  });

  controller.on('step:error', ({ error }) => {
    panel.log(`{red-fg}[ERROR] ${error.message}{/red-fg}`);
    screen.render();
  });

  return panel;
}
