import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseWorkflow } from '../src/parser/workflow.js';
import { createExpressionContext } from '../src/parser/expressions.js';
import { StepRunner } from '../src/runner/step.js';
import { Controller, State, StepStatus } from '../src/tui/controller.js';

const ciWorkflow = `
name: CI Pipeline
on: push

env:
  NODE_ENV: test

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install dependencies
        run: npm install
      - name: Run tests
        run: npm test
        env:
          CI: true
      - name: Build
        run: npm run build
`;

const multiJobWorkflow = `
name: Multi-Job
on: push

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Lint
        run: echo "linting"
  test:
    runs-on: ubuntu-latest
    needs: lint
    steps:
      - name: Test
        run: echo "testing"
  deploy:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy
        run: echo "deploying"
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
`;

/**
 * Create a mock DockerRunner that simulates container lifecycle.
 * execFn is called for both exec and execStream — receives the command array.
 */
function createMockDockerRunner(execFn) {
  const defaultExecFn = () => ({ exitCode: 0, stdout: 'ok\n', stderr: '' });
  const fn = execFn || defaultExecFn;

  const runner = {
    container: { id: 'mock-container-id' },
    _containerId: 'mock-container-id',

    isAvailable: vi.fn(async () => true),

    pullImage: vi.fn(async (image, options = {}) => {
      if (options.onProgress) {
        options.onProgress({ status: 'Pull complete', id: 'abc123', progress: '' });
      }
    }),

    createContainer: vi.fn(async (options) => {
      return runner.container;
    }),

    exec: vi.fn(async (command, options) => {
      return fn(command, options);
    }),

    execStream: vi.fn(async (command, options = {}) => {
      const result = fn(command, options);
      if (options.onStdout && result.stdout) options.onStdout(result.stdout);
      if (options.onStderr && result.stderr) options.onStderr(result.stderr);
      return result;
    }),

    cleanup: vi.fn(async () => {}),

    shellInContainer: vi.fn(() => ({
      containerId: 'mock-container-id',
      cmd: ['docker', 'exec', '-it', 'mock-container-id', 'bash'],
    })),
  };

  return runner;
}

describe('Integration: Parser → Runner → Controller pipeline', () => {
  describe('workflow parsing and step execution', () => {
    it('parses a CI workflow and runs steps through the controller', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner((cmd) => {
        const script = Array.isArray(cmd) ? cmd[cmd.length - 1] : cmd;
        if (script.includes('npm install')) {
          return { exitCode: 0, stdout: 'added 120 packages\n', stderr: '' };
        }
        if (script.includes('npm test')) {
          return { exitCode: 0, stdout: 'Tests passed: 42\n', stderr: '' };
        }
        if (script.includes('npm run build')) {
          return { exitCode: 0, stdout: 'Build complete\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'ok\n', stderr: '' };
      });

      const expressionContext = createExpressionContext({
        env: { NODE_ENV: 'test' },
      });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      expect(ctrl.state).toBe(State.WAITING);
      expect(ctrl.steps).toHaveLength(4);

      // Step 0: uses: checkout — deferred by StepRunner
      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
      expect(ctrl.steps[0].result.stdout).toContain('actions/checkout@v4');

      // Step 1: npm install
      await ctrl.runStep(1);
      expect(ctrl.steps[1].status).toBe(StepStatus.PASSED);

      // Step 2: npm test
      await ctrl.runStep(2);
      expect(ctrl.steps[2].status).toBe(StepStatus.PASSED);

      // Step 3: npm run build
      await ctrl.runStep(3);
      expect(ctrl.steps[3].status).toBe(StepStatus.PASSED);
      expect(ctrl.state).toBe(State.DONE);
    });

    it('handles step failure and continues to WAITING', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 1,
        stdout: '',
        stderr: 'npm ERR! install failed\n',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      ctrl.skipStep(0); // skip checkout

      await ctrl.runStep(1);
      expect(ctrl.steps[1].status).toBe(StepStatus.FAILED);
      expect(ctrl.steps[1].result.stderr).toContain('install failed');
      expect(ctrl.state).toBe(State.WAITING);
    });
  });

  describe('multi-job workflow parsing', () => {
    it('parses multi-job workflows and selects correct job', () => {
      const workflow = parseWorkflow(multiJobWorkflow);

      expect(Object.keys(workflow.jobs)).toEqual(['lint', 'test', 'deploy']);
      expect(workflow.jobs.test.needs).toEqual(['lint']);
      expect(workflow.jobs.deploy.needs).toEqual(['test']);
      expect(workflow.jobs.deploy.if).toBe("github.ref == 'refs/heads/main'");
    });

    it('runs selected job steps with expression context', async () => {
      const workflow = parseWorkflow(multiJobWorkflow);
      const job = workflow.jobs.lint;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0, stdout: 'linting done\n', stderr: '',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'lint' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
      expect(ctrl.state).toBe(State.DONE);
    });
  });

  describe('streaming output integration', () => {
    it('emits output events during step execution', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0,
        stdout: 'line 1\nline 2\n',
        stderr: 'warn: something\n',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      const outputChunks = [];
      ctrl.on('output', (chunk) => outputChunks.push(chunk));

      ctrl.start();
      ctrl.skipStep(0); // skip checkout
      await ctrl.runStep(1);

      expect(outputChunks.length).toBeGreaterThan(0);
      const allOutput = outputChunks.join('');
      expect(allOutput).toContain('line 1');
      expect(allOutput).toContain('line 2');
    });

    it('streams stderr with red tags', async () => {
      const workflowYaml = `
name: Stderr Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Warn step
        run: echo "warn" >&2
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0,
        stdout: '',
        stderr: 'warning message\n',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      const outputChunks = [];
      ctrl.on('output', (chunk) => outputChunks.push(chunk));

      ctrl.start();
      await ctrl.runStep(0);

      const allOutput = outputChunks.join('');
      expect(allOutput).toContain('warning message');
      expect(allOutput).toContain('red-fg');
    });
  });

  describe('Docker lifecycle integration', () => {
    it('checks Docker availability via controller.initContainer', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner();

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        expressionContext: createExpressionContext({ env: {} }),
      });

      await ctrl.initContainer({ workspacePath: '/tmp/workspace' });

      expect(dockerRunner.isAvailable).toHaveBeenCalled();
      expect(dockerRunner.pullImage).toHaveBeenCalled();
      expect(dockerRunner.createContainer).toHaveBeenCalled();

      const createCall = dockerRunner.createContainer.mock.calls[0][0];
      expect(createCall.binds).toContain('/tmp/workspace:/github/workspace');
    });

    it('throws clear error when Docker is not available', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner();
      dockerRunner.isAvailable = vi.fn(async () => false);

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        expressionContext: createExpressionContext({ env: {} }),
      });

      await expect(ctrl.initContainer()).rejects.toThrow(/Docker is not running/);
    });

    it('maps runs-on to correct Docker image', async () => {
      const workflowYaml = `
name: Image Map
on: push
jobs:
  test:
    runs-on: ubuntu-20.04
    steps:
      - run: echo hi
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner();

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        expressionContext: createExpressionContext({ env: {} }),
      });

      await ctrl.initContainer();

      const pullCall = dockerRunner.pullImage.mock.calls[0];
      expect(pullCall[0]).toBe('ubuntu:20.04');
    });

    it('cleans up container on controller cleanup', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner();

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        expressionContext: createExpressionContext({ env: {} }),
      });

      await ctrl.cleanup();
      expect(dockerRunner.cleanup).toHaveBeenCalled();
    });
  });

  describe('expression evaluation through pipeline', () => {
    it('evaluates step env expressions before execution', async () => {
      const workflowYaml = `
name: Env Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: With env
        run: echo $MY_VAR
        env:
          MY_VAR: \${{ env.BASE_VAR }}-suffix
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0, stdout: 'hello-suffix\n', stderr: '',
      }));

      const expressionContext = createExpressionContext({
        env: { BASE_VAR: 'hello' },
      });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      await ctrl.runStep(0);
      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
    });

    it('passes step outputs into expression context for subsequent steps', async () => {
      const workflowYaml = `
name: Output Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - id: gen
        name: Generate output
        run: echo "::set-output name=version::1.2.3"
      - name: Use output
        run: echo "version is \${{ steps.gen.outputs.version }}"
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner((cmd) => {
        const script = Array.isArray(cmd) ? cmd[cmd.length - 1] : cmd;
        if (script.includes('set-output')) {
          return { exitCode: 0, stdout: '::set-output name=version::1.2.3\n', stderr: '' };
        }
        return { exitCode: 0, stdout: 'version is 1.2.3\n', stderr: '' };
      });

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();

      await ctrl.runStep(0);
      expect(ctrl.steps[0].result.outputs.version).toBe('1.2.3');
      expect(ctrl.expressionContext.steps.gen.outputs.version).toBe('1.2.3');

      await ctrl.runStep(1);
      expect(ctrl.steps[1].status).toBe(StepStatus.PASSED);
    });
  });

  describe('auto-run modes through pipeline', () => {
    it('runAll executes all steps sequentially', async () => {
      const workflowYaml = `
name: AutoRun
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Step 1
        run: echo "one"
      - name: Step 2
        run: echo "two"
      - name: Step 3
        run: echo "three"
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0, stdout: 'done\n', stderr: '',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      await ctrl.runAll();

      expect(ctrl.steps.every((s) => s.status === StepStatus.PASSED)).toBe(true);
      expect(ctrl.state).toBe(State.DONE);
    });

    it('runToBreakpoint stops at breakpoint', async () => {
      const workflowYaml = `
name: Breakpoint
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Step 1
        run: echo "one"
      - name: Step 2
        run: echo "two"
      - name: Step 3
        run: echo "three"
`;
      const workflow = parseWorkflow(workflowYaml);
      const job = workflow.jobs.test;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0, stdout: 'done\n', stderr: '',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);

      const ctrl = new Controller({
        job: { ...job, id: 'test' },
        dockerRunner,
        stepRunner,
        expressionContext,
      });

      ctrl.start();
      ctrl.toggleBreakpoint(1);
      await ctrl.runToBreakpoint();

      expect(ctrl.steps[0].status).toBe(StepStatus.PASSED);
      expect(ctrl.steps[1].status).toBe(StepStatus.PENDING);
      expect(ctrl.state).toBe(State.WAITING);
    });
  });

  describe('recorder integration through pipeline', () => {
    it('records step results as they execute', async () => {
      const workflow = parseWorkflow(ciWorkflow);
      const job = workflow.jobs.build;

      const dockerRunner = createMockDockerRunner(() => ({
        exitCode: 0, stdout: 'installed\n', stderr: '',
      }));

      const expressionContext = createExpressionContext({ env: {} });
      const stepRunner = new StepRunner(dockerRunner, expressionContext);
      const recorder = { recordStep: vi.fn() };

      const ctrl = new Controller({
        job: { ...job, id: 'build' },
        dockerRunner,
        stepRunner,
        expressionContext,
        recorder,
      });

      ctrl.start();
      ctrl.skipStep(0); // skip checkout
      await ctrl.runStep(1); // npm install

      expect(recorder.recordStep).toHaveBeenCalledTimes(1);
      expect(recorder.recordStep).toHaveBeenCalledWith(
        'build',
        expect.objectContaining({ name: 'Install dependencies' }),
        expect.objectContaining({ success: true })
      );
    });
  });
});
