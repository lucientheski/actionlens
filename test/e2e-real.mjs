#!/usr/bin/env node
/**
 * End-to-end reality check: run actionlens's own CI workflow headlessly.
 * No TUI — just parse, create container, run each step, report results.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflow } from '../src/parser/workflow.js';
import { createExpressionContext } from '../src/parser/expressions.js';
import { DockerRunner } from '../src/runner/docker.js';
import { StepRunner } from '../src/runner/step.js';
import { ActionRunner } from '../src/runner/actions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

async function main() {
  console.log('=== actionlens e2e reality check ===\n');

  // 1. Parse the workflow
  const workflowPath = resolve(repoRoot, '.github/workflows/ci.yml');
  const content = readFileSync(workflowPath, 'utf-8');
  const workflow = parseWorkflow(content);
  console.log(`Workflow: ${workflow.name}`);

  const jobId = Object.keys(workflow.jobs)[0];
  const job = workflow.jobs[jobId];
  console.log(`Job: ${jobId} (${job.steps.length} steps)\n`);

  // 2. Set up Docker
  const dockerRunner = new DockerRunner();
  const available = await dockerRunner.isAvailable();
  if (!available) {
    console.error('Docker not available!');
    process.exit(1);
  }

  // 3. Pull image
  const image = 'catthehacker/ubuntu:act-latest';
  console.log(`Pulling ${image}...`);
  await dockerRunner.pullImage(image, {});
  console.log('Image ready.\n');

  // 4. Create container with workspace mounted
  console.log(`Creating container (workspace: ${repoRoot})...`);
  await dockerRunner.createContainer({
    image,
    env: { ...workflow.env, ...job.env },
    binds: [`${repoRoot}:/github/workspace`],
  });
  console.log('Container started.\n');

  // 5. Expression context
  const expressionContext = createExpressionContext({
    env: { ...process.env, ...job.env, ...workflow.env },
    secrets: {},
    github: { event_name: 'push', repository: repoRoot },
  });

  const stepRunner = new StepRunner(dockerRunner, expressionContext);
  const actionRunner = new ActionRunner(dockerRunner);

  // 6. Run each step
  const results = [];
  for (const [i, step] of job.steps.entries()) {
    const label = step.name || step.run || step.uses || 'unnamed';
    const type = step.uses ? 'uses' : 'run';
    console.log(`--- Step ${i + 1}: [${type}] ${label} ---`);

    try {
      if (step.uses) {
        // Try running the action
        console.log(`  Action: ${step.uses}`);
        const result = await actionRunner.run(step, {
          dockerRunner,
          expressionContext,
          workspacePath: repoRoot,
        });
        console.log(`  Result: ${result.success ? '✅ PASS' : '❌ FAIL'} (exit ${result.exitCode})`);
        if (result.stdout) console.log(`  Stdout: ${result.stdout.slice(0, 200)}`);
        if (result.stderr) console.log(`  Stderr: ${result.stderr.slice(0, 200)}`);
        results.push({ step: i + 1, label, success: result.success });
      } else if (step.run) {
        const result = await stepRunner.run(step, {
          onStdout: (data) => process.stdout.write(`  | ${data}`),
          onStderr: (data) => process.stderr.write(`  ! ${data}`),
        });
        console.log(`\n  Result: ${result.success ? '✅ PASS' : '❌ FAIL'} (exit ${result.exitCode})`);
        results.push({ step: i + 1, label, success: result.success });
      }
    } catch (err) {
      console.log(`  💥 ERROR: ${err.message}`);
      results.push({ step: i + 1, label, success: false, error: err.message });
    }
    console.log();
  }

  // 7. Cleanup
  try {
    await dockerRunner.cleanup();
    console.log('Container cleaned up.\n');
  } catch (e) {
    console.log(`Cleanup warning: ${e.message}\n`);
  }

  // 8. Summary
  console.log('=== SUMMARY ===');
  for (const r of results) {
    const icon = r.success ? '✅' : '❌';
    console.log(`  ${icon} Step ${r.step}: ${r.label}${r.error ? ` (${r.error})` : ''}`);
  }
  const passed = results.filter(r => r.success).length;
  console.log(`\n${passed}/${results.length} steps passed.`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
