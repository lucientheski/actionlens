#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { parseWorkflow } from '../src/parser/workflow.js';

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

      console.log(chalk.bold.cyan(`\n🔍 ActionLens — debugging: ${workflowPath}\n`));
      console.log(chalk.dim(`Workflow: ${workflow.name}`));
      console.log(chalk.dim(`Jobs: ${Object.keys(workflow.jobs).join(', ')}\n`));

      // Phase 1: just list what would run
      for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (options.job && options.job !== jobId) continue;

        console.log(chalk.bold.yellow(`Job: ${jobId}`) + chalk.dim(` (runs-on: ${job.runsOn})`));
        for (const [i, step] of job.steps.entries()) {
          const num = i + 1;
          const label = step.name || step.run || step.uses || 'unnamed step';
          console.log(chalk.green(`  ${num}. ${label}`));
        }
        console.log();
      }

      console.log(chalk.dim('Full Docker execution coming in Phase 2.'));
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
