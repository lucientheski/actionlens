import blessed from 'blessed';

/**
 * Status bar — shows job name, step index, breakpoints, container status.
 * Command bar — shows available key bindings.
 */
export function createStatusBar(screen, controller) {
  const bar = blessed.box({
    parent: screen,
    bottom: 1,
    left: 0,
    width: '100%',
    height: 1,
    style: {
      bg: 'blue',
      fg: 'white',
    },
    tags: true,
  });

  const commandBar = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    style: {
      bg: 'black',
      fg: 'gray',
    },
    tags: true,
  });

  commandBar.setContent(
    ' {bold}R{/bold}un  {bold}S{/bold}kip  {bold}I{/bold}nteractive  {bold}B{/bold}reakpoint  {bold}N{/bold}ext-bp  {bold}A{/bold}ll  {bold}E{/bold}nv  {bold}V{/bold}ars  {bold}Q{/bold}uit  {bold}Tab{/bold} Focus  {bold}↑↓{/bold} Nav'
  );

  function render() {
    const bpCount = controller.breakpoints.size;
    const stepNum = controller.selectedIndex + 1;
    const total = controller.steps.length;
    const state = controller.state;
    const docker = controller.containerStatus;
    const bpText = bpCount > 0 ? `{red-fg}${bpCount} bp{/red-fg}` : '0 bp';

    bar.setContent(
      ` Job: {bold}${controller.jobName}{/bold}` +
      `  |  Step: {bold}${stepNum}/${total}{/bold}` +
      `  |  Breakpoints: ${bpText}` +
      `  |  Docker: ${docker}` +
      `  |  State: {bold}${state}{/bold}`
    );
    screen.render();
  }

  controller.on('refresh', render);
  controller.on('state', render);
  render();

  return { bar, commandBar };
}
