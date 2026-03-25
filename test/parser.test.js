import { describe, it, expect } from 'vitest';
import { parseWorkflow, normalizeStep } from '../src/parser/workflow.js';
import { evaluateExpression, createExpressionContext } from '../src/parser/expressions.js';
import { loadSecretsIsolated } from '../src/secrets/loader.js';
import { SessionRecorder } from '../src/recorder/session.js';
import { writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const sampleWorkflow = `
name: CI
on: [push, pull_request]

env:
  NODE_ENV: production

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install deps
        run: npm install
      - name: Run tests
        run: npm test
        env:
          CI: true

  deploy:
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: echo "deploying"
        env:
          TOKEN: \${{ secrets.DEPLOY_TOKEN }}
`;

describe('Workflow Parser', () => {
  it('parses a valid workflow YAML', () => {
    const workflow = parseWorkflow(sampleWorkflow);

    expect(workflow.name).toBe('CI');
    expect(workflow.env).toEqual({ NODE_ENV: 'production' });
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'deploy']);
  });

  it('parses trigger events', () => {
    const workflow = parseWorkflow(sampleWorkflow);

    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('pull_request');
  });

  it('normalizes job properties', () => {
    const workflow = parseWorkflow(sampleWorkflow);
    const build = workflow.jobs.build;

    expect(build.runsOn).toBe('ubuntu-latest');
    expect(build.needs).toEqual([]);
    expect(build.steps).toHaveLength(3);
  });

  it('normalizes job dependencies', () => {
    const workflow = parseWorkflow(sampleWorkflow);
    const deploy = workflow.jobs.deploy;

    expect(deploy.needs).toEqual(['build']);
  });

  it('normalizes steps with uses', () => {
    const workflow = parseWorkflow(sampleWorkflow);
    const step = workflow.jobs.build.steps[0];

    expect(step.uses).toBe('actions/checkout@v4');
    expect(step.run).toBeNull();
    expect(step.index).toBe(0);
  });

  it('normalizes steps with run', () => {
    const workflow = parseWorkflow(sampleWorkflow);
    const step = workflow.jobs.build.steps[1];

    expect(step.name).toBe('Install deps');
    expect(step.run).toBe('npm install');
    expect(step.uses).toBeNull();
  });

  it('captures step-level env', () => {
    const workflow = parseWorkflow(sampleWorkflow);
    const step = workflow.jobs.build.steps[2];

    expect(step.env).toEqual({ CI: true });
  });

  it('throws on invalid YAML', () => {
    expect(() => parseWorkflow('not: valid: yaml: [')).toThrow();
  });

  it('throws on missing jobs section', () => {
    expect(() => parseWorkflow('name: NoJobs\non: push\n')).toThrow(/missing "jobs"/);
  });

  it('handles string trigger', () => {
    const workflow = parseWorkflow('name: Test\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n');
    expect(workflow.on).toHaveProperty('push');
  });
});

describe('normalizeStep', () => {
  it('sets defaults for missing fields', () => {
    const step = normalizeStep({ run: 'echo hello' }, 0);

    expect(step.id).toBeNull();
    expect(step.name).toBeNull();
    expect(step.uses).toBeNull();
    expect(step.with).toEqual({});
    expect(step.env).toEqual({});
    expect(step.if).toBeNull();
    expect(step.shell).toBeNull();
    expect(step.continueOnError).toBe(false);
  });
});

describe('Expression Evaluator', () => {
  const context = createExpressionContext({
    env: { NODE_ENV: 'production', CI: 'true' },
    secrets: { DEPLOY_TOKEN: 'abc123', API_KEY: 'xyz789' },
    github: {
      event_name: 'push',
      ref: 'refs/heads/main',
      sha: 'abcdef1234567890',
      repository: 'owner/repo',
    },
    steps: {
      build: { outputs: { artifact: 'dist.tar.gz' } },
    },
  });

  it('resolves env variables', () => {
    expect(evaluateExpression('${{ env.NODE_ENV }}', context)).toBe('production');
    expect(evaluateExpression('${{ env.CI }}', context)).toBe('true');
  });

  it('resolves secrets', () => {
    expect(evaluateExpression('${{ secrets.DEPLOY_TOKEN }}', context)).toBe('abc123');
  });

  it('resolves github context', () => {
    expect(evaluateExpression('${{ github.event_name }}', context)).toBe('push');
    expect(evaluateExpression('${{ github.ref }}', context)).toBe('refs/heads/main');
  });

  it('resolves step outputs', () => {
    expect(evaluateExpression('${{ steps.build.outputs.artifact }}', context)).toBe('dist.tar.gz');
  });

  it('handles multiple expressions in one string', () => {
    const result = evaluateExpression('env=${{ env.NODE_ENV }}, event=${{ github.event_name }}', context);
    expect(result).toBe('env=production, event=push');
  });

  it('returns empty string for undefined references', () => {
    expect(evaluateExpression('${{ env.NONEXISTENT }}', context)).toBe('');
    expect(evaluateExpression('${{ secrets.NOPE }}', context)).toBe('');
  });

  it('handles strings without expressions', () => {
    expect(evaluateExpression('plain string', context)).toBe('plain string');
  });

  it('handles non-string input', () => {
    expect(evaluateExpression(42, context)).toBe(42);
    expect(evaluateExpression(null, context)).toBeNull();
  });

  it('handles contains() function', () => {
    expect(evaluateExpression("${{ contains(github.ref, 'main') }}", context)).toBe('true');
    expect(evaluateExpression("${{ contains(github.ref, 'develop') }}", context)).toBe('false');
  });

  it('handles startsWith() function', () => {
    expect(evaluateExpression("${{ startsWith(github.ref, 'refs/heads') }}", context)).toBe('true');
    expect(evaluateExpression("${{ startsWith(github.ref, 'refs/tags') }}", context)).toBe('false');
  });

  it('handles string literals', () => {
    expect(evaluateExpression("${{ 'hello' }}", context)).toBe('hello');
  });
});

describe('Secrets Loader', () => {
  const testEnvPath = resolve('.test-secrets.env');

  it('loads secrets from env file', () => {
    writeFileSync(testEnvPath, 'MY_SECRET=hunter2\nAPI_KEY=abc123\n');
    const secrets = loadSecretsIsolated(testEnvPath);

    expect(secrets.MY_SECRET).toBe('hunter2');
    expect(secrets.API_KEY).toBe('abc123');

    unlinkSync(testEnvPath);
  });

  it('handles quoted values', () => {
    writeFileSync(testEnvPath, 'QUOTED="hello world"\nSINGLE=\'foo bar\'\n');
    const secrets = loadSecretsIsolated(testEnvPath);

    expect(secrets.QUOTED).toBe('hello world');
    expect(secrets.SINGLE).toBe('foo bar');

    unlinkSync(testEnvPath);
  });

  it('skips comments and empty lines', () => {
    writeFileSync(testEnvPath, '# comment\n\nKEY=value\n');
    const secrets = loadSecretsIsolated(testEnvPath);

    expect(Object.keys(secrets)).toEqual(['KEY']);
    expect(secrets.KEY).toBe('value');

    unlinkSync(testEnvPath);
  });

  it('returns empty object for missing file', () => {
    const secrets = loadSecretsIsolated('/nonexistent/.env');
    expect(secrets).toEqual({});
  });
});

describe('Session Recorder', () => {
  const testDir = resolve('.test-recordings');

  it('creates a session with unique id', () => {
    const recorder = new SessionRecorder({ outputDir: testDir });
    expect(recorder.session.id).toMatch(/^session-/);
    expect(recorder.session.startedAt).toBeTruthy();
  });

  it('records workflow and steps', () => {
    const recorder = new SessionRecorder({ outputDir: testDir });

    recorder.setWorkflow({ name: 'CI', jobs: { build: {} } });
    recorder.startJob('build');
    recorder.recordStep('build', { index: 0, name: 'Install' }, {
      success: true,
      exitCode: 0,
      stdout: 'installed',
      stderr: '',
      outputs: {},
    });
    recorder.completeJob('build', true);

    expect(recorder.session.workflow.name).toBe('CI');
    expect(recorder.session.jobs.build.steps).toHaveLength(1);
    expect(recorder.session.jobs.build.success).toBe(true);
  });

  it('saves and loads recordings', () => {
    const recorder = new SessionRecorder({ outputDir: testDir });
    recorder.setWorkflow({ name: 'Test', jobs: { test: {} } });
    recorder.startJob('test');
    recorder.recordStep('test', { index: 0, name: 'Step 1' }, {
      success: true, exitCode: 0, stdout: '', stderr: '', outputs: {},
    });

    const filePath = recorder.save();
    const loaded = SessionRecorder.load(filePath);

    expect(loaded.workflow.name).toBe('Test');
    expect(loaded.jobs.test.steps).toHaveLength(1);

    rmSync(testDir, { recursive: true, force: true });
  });
});
