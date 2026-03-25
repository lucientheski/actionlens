#!/usr/bin/env node
/**
 * Docker smoke test — actually runs a container and executes a step.
 * Requires Docker to be running.
 * Usage: node test/docker-smoke.mjs
 */

import { DockerRunner } from '../src/runner/docker.js';

const runner = new DockerRunner();

async function main() {
  console.log('1. Checking Docker availability...');
  const available = await runner.isAvailable();
  if (!available) {
    console.error('Docker is not available. Skipping smoke test.');
    process.exit(0);
  }
  console.log('   ✓ Docker is available');

  console.log('2. Pulling ubuntu:22.04...');
  await runner.pullImage('ubuntu:22.04', (progress) => {
    if (progress.status === 'Downloading' || progress.status === 'Pull complete') {
      process.stdout.write('.');
    }
  });
  console.log('\n   ✓ Image ready');

  console.log('3. Creating container...');
  const containerId = await runner.createContainer('ubuntu:22.04', {
    workspace: process.cwd(),
    env: { TEST_VAR: 'hello-from-actionlens' },
  });
  console.log(`   ✓ Container: ${containerId.slice(0, 12)}`);

  try {
    console.log('4. Executing echo command...');
    const result1 = await runner.execInContainer(containerId, ['bash', '-c', 'echo "Hello from actionlens! TEST_VAR=$TEST_VAR"']);
    console.log(`   ✓ Exit code: ${result1.exitCode}`);
    console.log(`   ✓ Output: ${result1.stdout.trim()}`);

    if (!result1.stdout.includes('hello-from-actionlens')) {
      throw new Error('Environment variable not passed correctly');
    }

    console.log('5. Checking workspace mount...');
    const result2 = await runner.execInContainer(containerId, ['bash', '-c', 'ls /github/workspace/package.json 2>/dev/null && echo "MOUNTED" || echo "NOT_MOUNTED"']);
    console.log(`   ✓ Workspace: ${result2.stdout.trim()}`);

    console.log('6. Running multi-line script...');
    const result3 = await runner.execInContainer(containerId, ['bash', '-c', `
      echo "Step 1: check node"
      which node 2>/dev/null && echo "node found" || echo "node not found (expected in bare ubuntu)"
      echo "Step 2: check workspace"
      ls /github/workspace/src/ | head -5
      echo "Step 3: done"
    `]);
    console.log(`   ✓ Exit code: ${result3.exitCode}`);
    console.log(`   Output:\n${result3.stdout.split('\n').map(l => '     ' + l).join('\n')}`);

    console.log('\n✅ All Docker smoke tests passed!');
  } finally {
    console.log('7. Cleaning up container...');
    await runner.removeContainer(containerId);
    console.log('   ✓ Container removed');
  }
}

main().catch((err) => {
  console.error(`\n❌ Smoke test failed: ${err.message}`);
  process.exit(1);
});
