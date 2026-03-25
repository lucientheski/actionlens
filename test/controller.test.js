import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Controller, State, StepStatus } from '../src/tui/controller.js';

function makeJob(stepCount = 3) {
  return {
    id: 'build',
    runsOn: 'ubuntu-latest',
    needs: [],
    env: {},
    if: null,
    steps: Array.from({ length: stepCount }, (_, i) => ({
      index: i,
      id: `step${i}`,
      name: `Step ${i + 1}`,
      uses: null,
      run: `echo "step ${i + 1}"`,
      with: {},
      env: { MY_VAR: 'hello' },
      if: null,
      workingDirectory: null,
      shell: null,
      continueOnError: false,
    })),
  };
}

function makeRunner(results = {}) {
  return {
    run: vi.fn(async (step) => {
      return results[step.index] || {
        success: true,
        exitCode: 0,
        stdout: `output from step ${step.index + 1}`,
        stderr: '',
        outputs: {},
        skipped: false,
      };
    }),
  };
}

describe('Controller', () => {
  let ctrl;

  beforeEach(() => {
    ctrl = new Controller({ job: makeJob() });
  });

  describe('initialization', () => {
    it('starts in IDLE state', () => {
      expect(ctrl.state).toBe(State.IDLE);
    });

    it('has all steps as pending', () => {
      expect(ctrl.steps.every((s) => s.status === StepStatus.PENDING)).toBe(true);
    });

    it('selectedIndex starts at 0', () => {
      expect(ctrl.selectedIndex).toBe(0);
    });

    it('exposes job name', () => {
      expect(ctrl.jobName).toBe('build');
    });
  });

  describe('start', () => {
    it('transitions from IDLE to WAITING', () => {
      const states = [];
      ctrl.on('state', (e) => states.push(e));
      ctrl.start();
      expect(ctrl.state).toBe(State.WAITING);
      expect(states).toEqual([{ from: 'IDLE', to: 'WAITING' }]);
    });

    it('emits ready event', () => {
      const ready = vi.fn();
      ctrl.on('ready', ready);
      ctrl.start();
      expect(ready).toHaveBeenCalledOnce();
    });

    it('does nothing if not IDLE', () => {
      ctrl.start();
      ctrl.start(); // second call is no-op
      expect(ctrl.state).toBe(State.WAITING);
    });
  });

  describe('navigation', () => {
    beforeEach(() => ctrl.start());

    it('selectNext moves down', () => {
      ctrl.selectNext();
      expect(ctrl.selectedIndex).toBe(1);
    });

    it('selectPrev moves up', () => {
      ctrl.selectNext();
      ctrl.selectPrev();
      expect(ctrl.selectedIndex).toBe(0);
    });

    it('does not go below 0', () => {
      ctrl.selectPrev();
      expect(ctrl.selectedIndex).toBe(0);
    });

    it('does not go past last step', () => {
      ctrl.selectNext();
      ctrl.selectNext();
      ctrl.selectNext(); // past end
      expect(ctrl.selectedIndex).toBe(2);
    });

    it('does not navigate when not WAITING', () => {
      ctrl._setState(State.RUNNING);
      ctrl.selectNext();
      expect(ctrl.selectedIndex).toBe(0);
    });
  });

  describe('breakpoints', () => {
    it('toggles breakpoint on', () => {
      ctrl.toggleBreakpoint(1);
      expect(ctrl.breakpoints.has(1)).toBe(true);
    });

    it('toggles breakpoint off', () => {
      ctrl.toggleBreakpoint(1);
      ctrl.toggleBreakpoint(1);
      expect(ctrl.breakpoints.has(1)).toBe(false);
    });

    it('emits breakpoint event', () => {
      const handler = vi.fn();
      ctrl.on('breakpoint', handler);
      ctrl.toggleBreakpoint(2);
      expect(handler).toHaveBeenCalledWith({ index: 2, active: true });
    });
  });

  describe('runStep', () => {
    it('executes a step and updates status to PASSED', async () => {
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
      expect(ctrl.steps[0].result.stdout).toBe('output from step 1');
      expect(ctrl.state).toBe(State.WAITING);
    });

    it('marks step as FAILED when runner returns failure', async () => {
      const runner = makeRunner({ 0: { success: false, exitCode: 1, stdout: '', stderr: 'error', outputs: {} } });
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.FAILED);
    });

    it('marks step as SKIPPED when result says skipped', async () => {
      const runner = makeRunner({ 0: { success: true, exitCode: 0, stdout: '', stderr: '', outputs: {}, skipped: true } });
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.SKIPPED);
    });

    it('transitions to DONE when all steps complete', async () => {
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(1), stepRunner: runner });
      ctrl.start();

      const done = vi.fn();
      ctrl.on('done', done);
      await ctrl.runStep(0);
      expect(ctrl.state).toBe(State.DONE);
      expect(done).toHaveBeenCalledOnce();
    });

    it('does nothing when not WAITING', async () => {
      ctrl = new Controller({ job: makeJob(), stepRunner: makeRunner() });
      // Don't start — state is IDLE
      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PENDING);
    });

    it('does nothing for already-run steps', async () => {
      ctrl = new Controller({ job: makeJob(), stepRunner: makeRunner() });
      ctrl.start();
      await ctrl.runStep(0);
      const prevResult = ctrl.steps[0].result;
      await ctrl.runStep(0); // already passed
      expect(ctrl.steps[0].result).toBe(prevResult);
    });

    it('emits step:start and step:end events', async () => {
      ctrl = new Controller({ job: makeJob(), stepRunner: makeRunner() });
      ctrl.start();

      const startHandler = vi.fn();
      const endHandler = vi.fn();
      ctrl.on('step:start', startHandler);
      ctrl.on('step:end', endHandler);

      await ctrl.runStep(0);
      expect(startHandler).toHaveBeenCalledOnce();
      expect(endHandler).toHaveBeenCalledOnce();
      expect(endHandler.mock.calls[0][0].result.success).toBe(true);
    });

    it('handles runner errors gracefully', async () => {
      const runner = { run: vi.fn(async () => { throw new Error('boom'); }) };
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.FAILED);
      expect(ctrl.steps[0].result.stderr).toBe('boom');
      expect(ctrl.state).toBe(State.WAITING);
    });

    it('updates expression context with step outputs', async () => {
      const runner = makeRunner({
        0: { success: true, exitCode: 0, stdout: '', stderr: '', outputs: { artifact: 'build.zip' } },
      });
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.expressionContext.steps.step0.outputs.artifact).toBe('build.zip');
    });
  });

  describe('skipStep', () => {
    beforeEach(() => {
      ctrl.start();
    });

    it('marks step as SKIPPED', () => {
      ctrl.skipStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.SKIPPED);
    });

    it('transitions to DONE when all steps skipped', () => {
      ctrl.skipStep(0);
      ctrl.skipStep(1);
      ctrl.skipStep(2);
      expect(ctrl.state).toBe(State.DONE);
    });

    it('does nothing for already-run steps', async () => {
      ctrl = new Controller({ job: makeJob(), stepRunner: makeRunner() });
      ctrl.start();
      await ctrl.runStep(0);
      ctrl.skipStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED); // not changed to skipped
    });
  });

  describe('runAll', () => {
    it('runs all pending steps sequentially', async () => {
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runAll();
      expect(ctrl.steps.every((s) => s.status === StepStatus.PASSED)).toBe(true);
      expect(ctrl.state).toBe(State.DONE);
      expect(runner.run).toHaveBeenCalledTimes(3);
    });
  });

  describe('runToBreakpoint', () => {
    it('stops at breakpoint', async () => {
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();
      ctrl.toggleBreakpoint(1); // breakpoint on step index 1

      await ctrl.runToBreakpoint();
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
      expect(ctrl.steps[1].status).toBe(StepStatus.PENDING); // stopped before running
      expect(ctrl.state).toBe(State.WAITING);
      expect(ctrl.autoRunMode).toBe(false);
    });

    it('runs all if no breakpoints', async () => {
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(), stepRunner: runner });
      ctrl.start();

      await ctrl.runToBreakpoint();
      expect(ctrl.steps.every((s) => s.status === StepStatus.PASSED)).toBe(true);
      expect(ctrl.state).toBe(State.DONE);
    });
  });

  describe('shell', () => {
    it('transitions to SHELL state', async () => {
      ctrl = new Controller({ job: makeJob(), dockerRunner: {} });
      ctrl.start();

      await ctrl.shellInto();
      expect(ctrl.state).toBe(State.SHELL);
    });

    it('returns to WAITING on shellDone', async () => {
      ctrl = new Controller({ job: makeJob(), dockerRunner: {} });
      ctrl.start();
      await ctrl.shellInto();
      ctrl.shellDone();
      expect(ctrl.state).toBe(State.WAITING);
    });

    it('emits output warning when no docker runner', async () => {
      ctrl.start();
      const output = vi.fn();
      ctrl.on('output', output);
      await ctrl.shellInto();
      expect(output).toHaveBeenCalled();
      expect(ctrl.state).toBe(State.WAITING); // didn't enter SHELL
    });
  });

  describe('getVariables', () => {
    it('returns expression context summary', () => {
      const ctx = {
        env: { FOO: 'bar' },
        secrets: { TOKEN: 'secret123' },
        github: { event_name: 'push' },
        steps: {},
      };
      ctrl = new Controller({ job: makeJob(), expressionContext: ctx });

      const vars = ctrl.getVariables();
      expect(vars.env).toEqual({ FOO: 'bar' });
      expect(vars.secrets).toEqual(['TOKEN']); // names only
      expect(vars.github).toEqual({ event_name: 'push' });
    });
  });

  describe('cleanup', () => {
    it('calls dockerRunner.cleanup', async () => {
      const docker = { cleanup: vi.fn(async () => {}) };
      ctrl = new Controller({ job: makeJob(), dockerRunner: docker });
      await ctrl.cleanup();
      expect(docker.cleanup).toHaveBeenCalledOnce();
    });

    it('handles cleanup errors gracefully', async () => {
      const docker = { cleanup: vi.fn(async () => { throw new Error('oops'); }) };
      ctrl = new Controller({ job: makeJob(), dockerRunner: docker });
      // Should not throw
      await ctrl.cleanup();
    });

    it('emits cleanup event', async () => {
      const handler = vi.fn();
      ctrl.on('cleanup', handler);
      await ctrl.cleanup();
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('recorder integration', () => {
    it('records step results when recorder is provided', async () => {
      const recorder = { recordStep: vi.fn() };
      const runner = makeRunner();
      ctrl = new Controller({ job: makeJob(), stepRunner: runner, recorder });
      ctrl.start();

      await ctrl.runStep(0);
      expect(recorder.recordStep).toHaveBeenCalledWith('build', ctrl.steps[0], expect.any(Object));
    });
  });
});
