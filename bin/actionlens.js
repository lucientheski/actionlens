#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { parseWorkflow } from '../src/parser/workflow.js';
import { createExpressionContext } from '../src/parser/expressions.js';
import { DockerRunner } from '../src/runner/docker.js';
import { StepRunner } from '../src/runner/step.js';
import { ActionRunner } from '../src/runner/actions.js';
import { loadSecretsIsolated } from '../src/secrets/loader.js';
import { SessionRecorder } from '../src/recorder/session.js';
import { DebuggerApp } from '../src/tui/app.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));

const program = new Command();

program
  .name('actionlens')
  .description('Interactive CI pipeline debugger for GitHub Actions')
  .version(pkg.version);

program
  .command('run <workflow>')
  .description('Run and debug a GitHub Actions workflow locally')
  .option('-j, --job <name>', 'Run a specific job')
  .option('-s, --step <number>', 'Start at a specific step (1-based)')
  .option('-b, --breakpoint <steps>', 'Comma-separated step numbers to pause at')
  .option('-e, --env-file <path>', 'Path to .env file for secrets', '.env')
  .action(async (workflowPath, options) => {
    try {
      const content = readFileSync(resolve(workflowPath), 'utf-8');
      const workflow = parseWorkflow(content);

      // Pick the job to debug
      const jobIds = Object.keys(workflow.jobs);
      const jobId = options.job || jobIds[0];
      const job = workflow.jobs[jobId];
      if (!job) {
        console.error(chalk.red(`Job "${jobId}" not found. Available: ${jobIds.join(', ')}`));
        process.exit(1);
      }

      // Load secrets and build expression context
      const secrets = loadSecretsIsolated(options.envFile);
      const expressionContext = createExpressionContext({
        env: { ...process.env, ...job.env, ...workflow.env },
        secrets,
        github: { event_name: 'workflow_dispatch', repository: process.cwd() },
      });

      // Set up Docker runner, step runner, action runner, recorder
      const dockerRunner = new DockerRunner();
      const stepRunner = new StepRunner(dockerRunner, expressionContext);
      const actionRunner = new ActionRunner(dockerRunner);
      const recorder = new SessionRecorder();
      recorder.setWorkflow(workflow);
      recorder.startJob(jobId);

      // Set initial breakpoints from CLI
      const breakpoints = options.breakpoint
        ? options.breakpoint.split(',').map((n) => parseInt(n, 10) - 1)
        : [];

      // Launch TUI
      const app = new DebuggerApp({
        job: { ...job, id: jobId },
        dockerRunner,
        stepRunner,
        actionRunner,
        recorder,
        expressionContext,
      });

      // Apply CLI breakpoints
      for (const bp of breakpoints) {
        app.controller.toggleBreakpoint(bp);
      }

      // If --step was given, advance selectedIndex
      if (options.step) {
        app.controller.selectedIndex = Math.max(0, parseInt(options.step, 10) - 1);
      }

      await app.run();

      recorder.completeJob(jobId, true);
      const sessionPath = recorder.save();
      console.log(chalk.dim(`\nSession saved: ${sessionPath}`));
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('list <workflow>')
  .description('List jobs and steps in a workflow')
  .action((workflowPath) => {
    try {
      const content = readFileSync(resolve(workflowPath), 'utf-8');
      const workflow = parseWorkflow(content);

      console.log(chalk.bold.cyan(`\nWorkflow: ${workflow.name}\n`));

      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        console.log(chalk.bold.yellow(`Job: ${jobId}`) + chalk.dim(` (runs-on: ${job.runsOn})`));
        for (const [i, step] of job.steps.entries()) {
          const num = i + 1;
          const type = step.uses ? chalk.magenta('[uses]') : chalk.blue('[run]');
          const label = step.name || step.run || step.uses || 'unnamed step';
          console.log(`  ${chalk.dim(num + '.')} ${type} ${label}`);
        }
        console.log();
      }
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command('version')
  .description('Show version')
  .action(() => {
    console.log(`actionlens v${pkg.version}`);
  });

program.parse();
