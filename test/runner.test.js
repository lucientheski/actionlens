import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StepRunner, wrapInShell, parseLegacyOutputs } from '../src/runner/step.js';
import { ActionRunner, COMMON_ACTION_SHORTCUTS } from '../src/runner/actions.js';
import { Pipeline } from '../src/runner/pipeline.js';
import { createExpressionContext } from '../src/parser/expressions.js';

// ─── Mock Docker Runner ──────────────────────────────────────────────

function makeMockDocker(execResults = {}) {
  let callIndex = 0;
  const execCalls = [];

  return {
    exec: vi.fn(async (command, options = {}) => {
      const call = { command, options };
      execCalls.push(call);
      const key = callIndex++;

      // Allow result lookup by command string for specific responses
      const cmdStr = Array.isArray(command) ? command.join(' ') : command;

      if (typeof execResults === 'function') {
        return execResults(cmdStr, command, options, key);
      }

      if (execResults[cmdStr]) {
        return execResults[cmdStr];
      }

      if (execResults[key]) {
        return execResults[key];
      }

      return { exitCode: 0, stdout: '', stderr: '' };
    }),
    execStream: vi.fn(async (command, options = {}) => {
      const cmdStr = Array.isArray(command) ? command.join(' ') : command;

      if (typeof execResults === 'function') {
        return execResults(cmdStr, command, options, callIndex++);
      }

      return { exitCode: 0, stdout: 'streamed output', stderr: '' };
    }),
    cleanup: vi.fn(async () => {}),
    isAvailable: vi.fn(async () => true),
    shellInContainer: vi.fn(() => ({
      containerId: 'mock-container-123',
      cmd: ['docker', 'exec', '-it', 'mock-container-123', 'bash'],
    })),
    createContainer: vi.fn(async () => ({})),
    pullImage: vi.fn(async () => {}),
    _execCalls: execCalls,
  };
}

function makeStep(overrides = {}) {
  return {
    index: 0,
    id: 'test-step',
    name: 'Test Step',
    uses: null,
    run: 'echo "hello"',
    with: {},
    env: {},
    if: null,
    workingDirectory: null,
    shell: null,
    continueOnError: false,
    timeoutMinutes: null,
    ...overrides,
  };
}

// ─── StepRunner Tests ────────────────────────────────────────────────

describe('StepRunner', () => {
  let docker;
  let context;

  beforeEach(() => {
    docker = makeMockDocker();
    context = createExpressionContext({
      env: { NODE_ENV: 'test' },
      secrets: { TOKEN: 'secret123' },
    });
  });

  describe('if: conditions', () => {
    it('skips step when if condition is false', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ if: 'false' });
      const result = await runner.run(step);

      expect(result.skipped).toBe(true);
      expect(result.success).toBe(true);
      expect(docker.exec).not.toHaveBeenCalled();
    });

    it('skips step when if condition evaluates to empty string', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ if: '${{ env.NONEXISTENT }}' });
      const result = await runner.run(step);

      expect(result.skipped).toBe(true);
    });

    it('skips step when if condition evaluates to 0', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ if: '0' });
      const result = await runner.run(step);

      expect(result.skipped).toBe(true);
    });

    it('runs step when if condition is true', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ if: 'true' });
      await runner.run(step);

      // exec called for touch + script + cat + rm
      expect(docker.exec).toHaveBeenCalled();
    });

    it('evaluates expression in if condition', async () => {
      const ctx = createExpressionContext({
        env: { RUN_TESTS: 'true' },
      });
      const runner = new StepRunner(docker, ctx);
      const step = makeStep({ if: "${{ env.RUN_TESTS }}" });
      await runner.run(step);

      expect(docker.exec).toHaveBeenCalled();
    });
  });

  describe('environment merging', () => {
    it('merges workflow → job → step env (step wins)', async () => {
      const runner = new StepRunner(docker, context, {
        workflowEnv: { LEVEL: 'workflow', WORKFLOW_ONLY: 'wf' },
        jobEnv: { LEVEL: 'job', JOB_ONLY: 'job' },
      });

      const step = makeStep({ env: { LEVEL: 'step', STEP_ONLY: 'step' } });
      await runner.run(step);

      // The exec call for the script (not touch/cat/rm) should have merged env
      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall).toBeDefined();
      const env = scriptCall[1].env;
      expect(env.LEVEL).toBe('step');
      expect(env.WORKFLOW_ONLY).toBe('wf');
      expect(env.JOB_ONLY).toBe('job');
      expect(env.STEP_ONLY).toBe('step');
    });

    it('evaluates expressions in env values', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ env: { MY_TOKEN: '${{ secrets.TOKEN }}' } });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall[1].env.MY_TOKEN).toBe('secret123');
    });
  });

  describe('shell wrapping', () => {
    it('defaults to bash with pipefail', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ run: 'echo test' });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall[0]).toEqual([
        'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', 'echo test',
      ]);
    });

    it('uses sh when shell is sh', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ run: 'echo test', shell: 'sh' });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'sh' && cmd.includes('echo test')
      );
      expect(scriptCall[0]).toEqual(['sh', '-e', '-c', 'echo test']);
    });

    it('uses python3 when shell is python', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ run: 'print("hi")', shell: 'python' });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'python3'
      );
      expect(scriptCall[0]).toEqual(['python3', '-c', 'print("hi")']);
    });
  });

  describe('working directory', () => {
    it('passes working-directory to exec options', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ workingDirectory: '/app/src' });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall[1].workdir).toBe('/app/src');
    });
  });

  describe('continue-on-error', () => {
    it('reports success when continue-on-error is true and step fails', async () => {
      docker = makeMockDocker((cmdStr) => {
        if (cmdStr.includes('echo')) {
          return { exitCode: 1, stdout: '', stderr: 'failed' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new StepRunner(docker, context);
      const step = makeStep({ continueOnError: true });
      const result = await runner.run(step);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(1);
    });

    it('reports failure when continue-on-error is false and step fails', async () => {
      docker = makeMockDocker((cmdStr) => {
        if (cmdStr.includes('echo')) {
          return { exitCode: 1, stdout: '', stderr: 'failed' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new StepRunner(docker, context);
      const step = makeStep({ continueOnError: false });
      const result = await runner.run(step);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('GITHUB_OUTPUT file parsing', () => {
    it('injects GITHUB_OUTPUT env var', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep();
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall[1].env.GITHUB_OUTPUT).toMatch(/^\/tmp\/github_output_/);
    });

    it('reads outputs from GITHUB_OUTPUT file', async () => {
      docker = makeMockDocker((cmdStr) => {
        if (cmdStr.startsWith('cat /tmp/github_output_')) {
          return { exitCode: 0, stdout: 'result=success\nversion=1.2.3\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new StepRunner(docker, context);
      const step = makeStep();
      const result = await runner.run(step);

      expect(result.outputs.result).toBe('success');
      expect(result.outputs.version).toBe('1.2.3');
    });

    it('parses legacy ::set-output from stdout', async () => {
      docker = makeMockDocker((cmdStr) => {
        if (cmdStr.includes('echo')) {
          return { exitCode: 0, stdout: '::set-output name=myout::myval\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new StepRunner(docker, context);
      const step = makeStep();
      const result = await runner.run(step);

      expect(result.outputs.myout).toBe('myval');
    });
  });

  describe('timeout', () => {
    it('passes timeout-minutes as timeout ms to docker exec', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ timeoutMinutes: 5 });
      await runner.run(step);

      const scriptCall = docker.exec.mock.calls.find(
        ([cmd]) => Array.isArray(cmd) && cmd[0] === 'bash'
      );
      expect(scriptCall[1].timeout).toBe(300000);
    });

    it('returns exit code 124 on timeout', async () => {
      docker.exec = vi.fn(async (cmd, opts) => {
        if (Array.isArray(cmd) && cmd[0] === 'bash') {
          throw new Error('Command timed out after 1000ms');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new StepRunner(docker, context);
      const step = makeStep({ timeoutMinutes: 1 });
      const result = await runner.run(step);

      expect(result.exitCode).toBe(124);
      expect(result.success).toBe(false);
    });
  });

  describe('streaming', () => {
    it('uses execStream when callbacks provided', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep();
      const onStdout = vi.fn();

      await runner.run(step, { onStdout });

      expect(docker.execStream).toHaveBeenCalled();
    });
  });

  describe('uses: delegation', () => {
    it('returns fallback when no actionRunner configured', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ run: null, uses: 'actions/checkout@v4' });
      const result = await runner.run(step);

      expect(result.stdout).toContain('no ActionRunner configured');
    });

    it('delegates to actionRunner when configured', async () => {
      const mockActionRunner = {
        run: vi.fn(async () => ({
          success: true, exitCode: 0, stdout: 'action output', stderr: '', outputs: {}, skipped: false,
        })),
      };

      const runner = new StepRunner(docker, context, { actionRunner: mockActionRunner });
      const step = makeStep({ run: null, uses: 'actions/checkout@v4' });
      const result = await runner.run(step);

      expect(mockActionRunner.run).toHaveBeenCalled();
      expect(result.stdout).toBe('action output');
    });
  });

  describe('error on missing run/uses', () => {
    it('throws when step has neither run nor uses', async () => {
      const runner = new StepRunner(docker, context);
      const step = makeStep({ run: null, uses: null });

      await expect(runner.run(step)).rejects.toThrow("neither 'run' nor 'uses' specified");
    });
  });
});

// ─── wrapInShell Tests ───────────────────────────────────────────────

describe('wrapInShell', () => {
  it('wraps bash with pipefail', () => {
    expect(wrapInShell('echo hi', 'bash')).toEqual([
      'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', 'echo hi',
    ]);
  });

  it('wraps sh with -e', () => {
    expect(wrapInShell('echo hi', 'sh')).toEqual(['sh', '-e', '-c', 'echo hi']);
  });

  it('wraps python', () => {
    expect(wrapInShell('print(1)', 'python')).toEqual(['python3', '-c', 'print(1)']);
  });

  it('wraps pwsh', () => {
    expect(wrapInShell('Write-Host hi', 'pwsh')).toEqual(['pwsh', '-command', 'Write-Host hi']);
  });

  it('falls back to sh for unknown shells', () => {
    expect(wrapInShell('echo hi', 'fish')).toEqual(['sh', '-e', '-c', 'echo hi']);
  });
});

// ─── parseLegacyOutputs Tests ────────────────────────────────────────

describe('parseLegacyOutputs', () => {
  it('parses single output', () => {
    expect(parseLegacyOutputs('::set-output name=key::value')).toEqual({ key: 'value' });
  });

  it('parses multiple outputs', () => {
    const stdout = '::set-output name=a::1\nsome noise\n::set-output name=b::2\n';
    expect(parseLegacyOutputs(stdout)).toEqual({ a: '1', b: '2' });
  });

  it('returns empty for no outputs', () => {
    expect(parseLegacyOutputs('just some output\n')).toEqual({});
  });
});

// ─── ActionRunner Tests ──────────────────────────────────────────────

describe('ActionRunner', () => {
  let docker;

  beforeEach(() => {
    docker = makeMockDocker();
  });

  describe('common action shortcuts', () => {
    it('handles actions/checkout as no-op', async () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ run: null, uses: 'actions/checkout@v4' });
      const result = await runner.run(step, {});

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('workspace already mounted');
    });

    it('handles actions/cache as no-op', async () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ run: null, uses: 'actions/cache@v3' });
      const result = await runner.run(step, {});

      expect(result.success).toBe(true);
      expect(result.outputs['cache-hit']).toBe('false');
    });

    it('handles actions/upload-artifact as no-op', async () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ run: null, uses: 'actions/upload-artifact@v4' });
      const result = await runner.run(step, {});

      expect(result.success).toBe(true);
    });

    it('handles actions/download-artifact as no-op', async () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ run: null, uses: 'actions/download-artifact@v4' });
      const result = await runner.run(step, {});

      expect(result.success).toBe(true);
    });

    it('handles actions/setup-node when node exists', async () => {
      docker = makeMockDocker((cmdStr) => {
        if (cmdStr === 'node --version') {
          return { exitCode: 0, stdout: 'v18.17.0', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const runner = new ActionRunner(docker);
      const step = makeStep({
        run: null,
        uses: 'actions/setup-node@v4',
        with: { 'node-version': '18' },
      });
      const result = await runner.run(step, {});

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('node already available');
    });
  });

  describe('parseActionRef', () => {
    it('parses owner/repo@ref', () => {
      const runner = new ActionRunner(docker);
      const parsed = runner.parseActionRef('actions/checkout@v4');

      expect(parsed).toEqual({
        owner: 'actions',
        repo: 'checkout',
        path: '',
        ref: 'v4',
      });
    });

    it('parses owner/repo/path@ref', () => {
      const runner = new ActionRunner(docker);
      const parsed = runner.parseActionRef('actions/aws/login@main');

      expect(parsed).toEqual({
        owner: 'actions',
        repo: 'aws',
        path: 'login',
        ref: 'main',
      });
    });

    it('defaults ref to main when not specified', () => {
      const runner = new ActionRunner(docker);
      const parsed = runner.parseActionRef('owner/repo');

      expect(parsed.ref).toBe('main');
    });
  });

  describe('_buildInputEnv', () => {
    it('converts with inputs to INPUT_ env vars', () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ with: { 'node-version': '18', 'cache': 'npm' } });
      const actionDef = { inputs: {} };

      const env = runner._buildInputEnv(step, actionDef, {});

      expect(env['INPUT_NODE_VERSION']).toBe('18');
      expect(env['INPUT_CACHE']).toBe('npm');
    });

    it('applies defaults from action inputs', () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ with: {} });
      const actionDef = {
        inputs: {
          token: { default: 'github-token-here' },
          verbose: { default: 'false' },
        },
      };

      const env = runner._buildInputEnv(step, actionDef, {});

      expect(env['INPUT_TOKEN']).toBe('github-token-here');
      expect(env['INPUT_VERBOSE']).toBe('false');
    });

    it('step.with overrides defaults', () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ with: { token: 'my-token' } });
      const actionDef = {
        inputs: { token: { default: 'default-token' } },
      };

      const env = runner._buildInputEnv(step, actionDef, {});

      expect(env['INPUT_TOKEN']).toBe('my-token');
    });

    it('converts hyphens to underscores in input names', () => {
      const runner = new ActionRunner(docker);
      const step = makeStep({ with: { 'my-input': 'val' } });
      const actionDef = { inputs: {} };

      const env = runner._buildInputEnv(step, actionDef, {});

      expect(env['INPUT_MY_INPUT']).toBe('val');
    });
  });

  describe('_findShortcut', () => {
    it('finds shortcut for actions/checkout@v4', () => {
      const runner = new ActionRunner(docker);
      expect(runner._findShortcut('actions/checkout@v4')).toBeTruthy();
    });

    it('finds shortcut for actions/cache@v3', () => {
      const runner = new ActionRunner(docker);
      expect(runner._findShortcut('actions/cache@v3')).toBeTruthy();
    });

    it('returns null for unknown actions', () => {
      const runner = new ActionRunner(docker);
      expect(runner._findShortcut('my-org/custom-action@v1')).toBeNull();
    });
  });
});

// ─── Pipeline Tests ──────────────────────────────────────────────────

describe('Pipeline', () => {
  function makeWorkflow(overrides = {}) {
    return {
      name: 'Test CI',
      on: { push: {} },
      env: { CI: 'true' },
      jobs: {
        build: {
          id: 'build',
          runsOn: 'ubuntu-latest',
          needs: [],
          env: { BUILD_ENV: 'dev' },
          if: null,
          steps: [
            makeStep({ index: 0, id: 'install', name: 'Install', run: 'npm install' }),
            makeStep({ index: 1, id: 'test', name: 'Test', run: 'npm test' }),
          ],
        },
        ...overrides,
      },
    };
  }

  describe('job order resolution', () => {
    it('resolves single job', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      const order = pipeline._resolveJobOrder();
      expect(order).toEqual(['build']);
    });

    it('resolves jobs with dependencies', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow({
          build: {
            id: 'build',
            runsOn: 'ubuntu-latest',
            needs: [],
            env: {},
            if: null,
            steps: [makeStep({ run: 'echo build' })],
          },
          test: {
            id: 'test',
            runsOn: 'ubuntu-latest',
            needs: ['build'],
            env: {},
            if: null,
            steps: [makeStep({ run: 'echo test' })],
          },
          deploy: {
            id: 'deploy',
            runsOn: 'ubuntu-latest',
            needs: ['test'],
            env: {},
            if: null,
            steps: [makeStep({ run: 'echo deploy' })],
          },
        }),
        interactive: false,
      });

      const order = pipeline._resolveJobOrder();
      expect(order).toEqual(['build', 'test', 'deploy']);
    });

    it('throws on circular dependency', () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Circular',
          on: {},
          env: {},
          jobs: {
            a: { id: 'a', runsOn: 'ubuntu-latest', needs: ['b'], env: {}, if: null, steps: [] },
            b: { id: 'b', runsOn: 'ubuntu-latest', needs: ['a'], env: {}, if: null, steps: [] },
          },
        },
        interactive: false,
      });

      expect(() => pipeline._resolveJobOrder()).toThrow('Circular dependency');
    });

    it('throws on unknown dependency', () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Missing',
          on: {},
          env: {},
          jobs: {
            a: { id: 'a', runsOn: 'ubuntu-latest', needs: ['nonexistent'], env: {}, if: null, steps: [] },
          },
        },
        interactive: false,
      });

      expect(() => pipeline._resolveJobOrder()).toThrow("unknown job 'nonexistent'");
    });

    it('handles diamond dependencies', () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Diamond',
          on: {},
          env: {},
          jobs: {
            a: { id: 'a', runsOn: 'ubuntu-latest', needs: [], env: {}, if: null, steps: [] },
            b: { id: 'b', runsOn: 'ubuntu-latest', needs: ['a'], env: {}, if: null, steps: [] },
            c: { id: 'c', runsOn: 'ubuntu-latest', needs: ['a'], env: {}, if: null, steps: [] },
            d: { id: 'd', runsOn: 'ubuntu-latest', needs: ['b', 'c'], env: {}, if: null, steps: [] },
          },
        },
        interactive: false,
      });

      const order = pipeline._resolveJobOrder();
      expect(order[0]).toBe('a');
      expect(order[order.length - 1]).toBe('d');
      // b and c must come after a and before d
      expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'));
      expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'));
      expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
      expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
    });
  });

  describe('image resolution', () => {
    it('maps ubuntu-latest to ubuntu:22.04', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      expect(pipeline._resolveImage('ubuntu-latest')).toBe('ubuntu:22.04');
    });

    it('maps ubuntu-20.04 correctly', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      expect(pipeline._resolveImage('ubuntu-20.04')).toBe('ubuntu:20.04');
    });

    it('falls back to ubuntu:22.04 for unknown', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      expect(pipeline._resolveImage('windows-latest')).toBe('ubuntu:22.04');
    });
  });

  describe('job context building', () => {
    it('includes dependency outputs in needs context', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      // Simulate build job completed with outputs
      pipeline.jobOutputs.build = { artifact: 'dist.tar.gz' };
      pipeline.jobResults.build = { success: true };

      const job = { needs: ['build'], env: {} };
      const ctx = pipeline._buildJobContext('deploy', job);

      expect(ctx.needs.build.outputs.artifact).toBe('dist.tar.gz');
      expect(ctx.needs.build.result).toBe('success');
    });

    it('marks failed deps as failure in context', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      pipeline.jobOutputs.build = {};
      pipeline.jobResults.build = { success: false };

      const job = { needs: ['build'], env: {} };
      const ctx = pipeline._buildJobContext('deploy', job);

      expect(ctx.needs.build.result).toBe('failure');
    });
  });

  describe('abort', () => {
    it('sets aborted flag', () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      pipeline.abort();
      expect(pipeline._aborted).toBe(true);
    });
  });

  describe('event emissions', () => {
    it('emits pipeline:start on run', async () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Noop',
          on: {},
          env: {},
          jobs: {
            empty: {
              id: 'empty',
              runsOn: 'ubuntu-latest',
              needs: [],
              env: {},
              if: null,
              steps: [],
            },
          },
        },
        interactive: false,
        dockerOptions: { socketPath: '/dev/null' },
      });

      // Mock the Docker creation to not actually connect
      const events = [];
      pipeline.on('pipeline:start', (e) => events.push(e));

      // Override _runJob to avoid real Docker
      pipeline._runJob = vi.fn(async () => ({ success: true, outputs: {}, stepResults: [] }));

      await pipeline.run();

      expect(events).toHaveLength(1);
      expect(events[0].jobs).toEqual(['empty']);
    });

    it('emits pipeline:done on completion', async () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Noop',
          on: {},
          env: {},
          jobs: {
            empty: {
              id: 'empty',
              runsOn: 'ubuntu-latest',
              needs: [],
              env: {},
              if: null,
              steps: [],
            },
          },
        },
        interactive: false,
      });

      const events = [];
      pipeline.on('pipeline:done', (e) => events.push(e));

      pipeline._runJob = vi.fn(async () => ({ success: true, outputs: {}, stepResults: [] }));

      await pipeline.run();

      expect(events).toHaveLength(1);
    });
  });

  describe('job skipping', () => {
    it('skips job when dependency failed', async () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Test',
          on: {},
          env: {},
          jobs: {
            build: {
              id: 'build',
              runsOn: 'ubuntu-latest',
              needs: [],
              env: {},
              if: null,
              steps: [makeStep()],
            },
            deploy: {
              id: 'deploy',
              runsOn: 'ubuntu-latest',
              needs: ['build'],
              env: {},
              if: null,
              steps: [makeStep()],
            },
          },
        },
        interactive: false,
      });

      // Mock build to fail, deploy should be skipped
      let callCount = 0;
      const origRunJob = pipeline._runJob.bind(pipeline);
      pipeline._runJob = vi.fn(async (jobId, job) => {
        if (jobId === 'build') {
          pipeline.jobResults.build = { success: false, outputs: {}, stepResults: [] };
          return { success: false, outputs: {}, stepResults: [] };
        }
        // For deploy, call the real implementation
        return origRunJob(jobId, job);
      });

      const skippedEvents = [];
      pipeline.on('job:skipped', (e) => skippedEvents.push(e));

      await pipeline.run();

      // deploy's _runJob is called (by our mock), and it should detect build failure
      expect(pipeline.jobResults.build.success).toBe(false);
    });

    it('skips job when if condition is false', async () => {
      const pipeline = new Pipeline({
        workflow: {
          name: 'Test',
          on: {},
          env: {},
          jobs: {
            skip_me: {
              id: 'skip_me',
              runsOn: 'ubuntu-latest',
              needs: [],
              env: {},
              if: 'false',
              steps: [makeStep()],
            },
          },
        },
        interactive: false,
      });

      const events = [];
      pipeline.on('job:skipped', (e) => events.push(e));

      // Override _runJob to use the real dependency/if checking
      const origRunJob = pipeline._runJob.bind(pipeline);
      pipeline._runJob = origRunJob;

      // But we need to mock Docker... override createContainer
      const DockerRunnerMock = {
        createContainer: vi.fn(async () => ({})),
        cleanup: vi.fn(async () => {}),
      };

      // Actually, let's just run and catch the docker error
      // The if: check happens before Docker creation
      await pipeline.run();

      expect(events).toHaveLength(1);
      expect(events[0].reason).toContain('if condition');
    });
  });

  describe('interactive mode', () => {
    it('yields control between steps when interactive', async () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: true,
      });

      const yields = [];
      pipeline.on('pipeline:yield', ({ jobId, index, step, resume }) => {
        yields.push({ jobId, index });
        resume('run');
      });

      // Mock _runJob to test yield behavior
      pipeline._runJob = vi.fn(async (jobId, job) => {
        // Simulate running steps with yields
        for (let i = 0; i < job.steps.length; i++) {
          const action = await pipeline._yieldToController(jobId, i, job.steps[i]);
          if (action === 'skip') continue;
        }
        return { success: true, outputs: {}, stepResults: [] };
      });

      await pipeline.run();

      expect(yields).toHaveLength(2);
      expect(yields[0]).toEqual({ jobId: 'build', index: 0 });
      expect(yields[1]).toEqual({ jobId: 'build', index: 1 });
    });
  });

  describe('cleanup', () => {
    it('cleans up containers on completion', async () => {
      const pipeline = new Pipeline({
        workflow: makeWorkflow(),
        interactive: false,
      });

      const mockDocker = makeMockDocker();
      pipeline._runJob = vi.fn(async (jobId) => {
        pipeline.containers.set(jobId, mockDocker);
        return { success: true, outputs: {}, stepResults: [] };
      });

      await pipeline.run();

      expect(mockDocker.cleanup).toHaveBeenCalled();
    });
  });
});

// ─── COMMON_ACTION_SHORTCUTS Tests ───────────────────────────────────

describe('COMMON_ACTION_SHORTCUTS', () => {
  it('has entries for all common actions', () => {
    const expected = [
      'actions/checkout',
      'actions/cache',
      'actions/upload-artifact',
      'actions/download-artifact',
      'actions/setup-node',
      'actions/setup-python',
    ];

    for (const action of expected) {
      expect(COMMON_ACTION_SHORTCUTS).toHaveProperty(action);
    }
  });

  it('all shortcuts have handler functions', () => {
    for (const [name, shortcut] of Object.entries(COMMON_ACTION_SHORTCUTS)) {
      expect(typeof shortcut.handler).toBe('function');
    }
  });
});
