import blessed from 'blessed';
import { StepStatus } from '../controller.js';

const STATUS_ICONS = {
  [StepStatus.PENDING]: '{gray-fg}○{/gray-fg}',
  [StepStatus.RUNNING]: '{yellow-fg}◉{/yellow-fg}',
  [StepStatus.PASSED]: '{green-fg}✓{/green-fg}',
  [StepStatus.FAILED]: '{red-fg}✗{/red-fg}',
  [StepStatus.SKIPPED]: '{gray-fg}◌{/gray-fg}',
};

/**
 * Step list panel — shows all steps with status indicators.
 */
export function createStepPanel(screen, controller) {
  const panel = blessed.list({
    parent: screen,
    label: ' Steps ',
    top: 0,
    left: 0,
    width: '35%',
    height: '100%-3',
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      selected: { bg: 'blue', fg: 'white' },
      item: { fg: 'white' },
      label: { fg: 'cyan', bold: true },
    },
    keys: false,
    mouse: false,
    scrollable: true,
    tags: true,
    focusable: true,
  });

  function render() {
    const items = controller.steps.map((step, i) => {
      const icon = STATUS_ICONS[step.status];
      const bp = controller.breakpoints.has(i) ? '{red-fg}●{/red-fg} ' : '  ';
      const label = step.name || (step.run ? step.run.slice(0, 40) : step.uses) || 'unnamed';
      const num = String(i + 1).padStart(2);
      return ` ${bp}${icon} ${num}. ${label}`;
    });
    panel.setItems(items);
    panel.select(controller.selectedIndex);
    screen.render();
  }

  controller.on('refresh', render);
  render();

  return panel;
}
