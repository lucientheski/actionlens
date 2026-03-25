import { resolve, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';

/**
 * Handles cloning, parsing, and executing `uses:` actions.
 * Supports GitHub-hosted actions (owner/repo@ref) and local actions (./path).
 */
export class ActionRunner {
  /**
   * @param {import('./docker.js').DockerRunner} dockerRunner
   * @param {object} [options]
   * @param {string} [options.cacheDir] - Directory to cache cloned actions
   */
  constructor(dockerRunner, options = {}) {
    this.docker = dockerRunner;
    this.cacheDir = options.cacheDir || resolve('.actionlens/actions-cache');
  }

  /**
   * Execute a `uses:` action step.
   *
   * @param {object} step - Normalized step with `uses` field
   * @param {object} context - Expression context
   * @returns {{ success: boolean, exitCode: number, stdout: string, stderr: string, outputs: object }}
   */
  async run(step, context) {
    const actionRef = step.uses;

    if (actionRef.startsWith('./') || actionRef.startsWith('../')) {
      return this.runLocalAction(actionRef, step, context);
    }

    return this.runRemoteAction(actionRef, step, context);
  }

  /**
   * Parse an action reference like "actions/checkout@v4" into parts.
   *
   * @param {string} ref - Action reference
   * @returns {{ owner: string, repo: string, path: string, ref: string }}
   */
  parseActionRef(ref) {
    const [repoPath, gitRef] = ref.split('@');
    const parts = repoPath.split('/');

    const owner = parts[0];
    const repo = parts[1];
    const path = parts.slice(2).join('/') || '';

    return { owner, repo, path, ref: gitRef || 'main' };
  }

  /**
   * Clone a remote action repo into the cache directory.
   *
   * @param {{ owner: string, repo: string, ref: string }} parsed
   * @returns {string} Path to cloned action
   */
  cloneAction(parsed) {
    const destDir = join(this.cacheDir, parsed.owner, parsed.repo, parsed.ref);

    if (existsSync(join(destDir, 'action.yml')) || existsSync(join(destDir, 'action.yaml'))) {
      return destDir;
    }

    mkdirSync(destDir, { recursive: true });

    const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    execSync(
      `git clone --depth 1 --branch ${parsed.ref} ${repoUrl} ${destDir}`,
      { stdio: 'pipe' }
    );

    return destDir;
  }

  /**
   * Read and parse an action.yml or action.yaml from a directory.
   *
   * @param {string} actionDir - Directory containing the action
   * @returns {object} Parsed action definition
   */
  parseActionYml(actionDir) {
    const ymlPath = join(actionDir, 'action.yml');
    const yamlPath = join(actionDir, 'action.yaml');

    const filePath = existsSync(ymlPath) ? ymlPath : existsSync(yamlPath) ? yamlPath : null;

    if (!filePath) {
      throw new Error(`No action.yml or action.yaml found in ${actionDir}`);
    }

    return yaml.load(readFileSync(filePath, 'utf-8'));
  }

  /**
   * Execute a remote (GitHub-hosted) action.
   */
  async runRemoteAction(actionRef, step, context) {
    const parsed = this.parseActionRef(actionRef);

    let actionDir;
    try {
      actionDir = this.cloneAction(parsed);
    } catch (err) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Failed to clone action ${actionRef}: ${err.message}`,
        outputs: {},
      };
    }

    if (parsed.path) {
      actionDir = join(actionDir, parsed.path);
    }

    return this.executeAction(actionDir, step, context);
  }

  /**
   * Execute a local action (./path reference).
   */
  async runLocalAction(actionRef, step, context) {
    const actionDir = resolve(actionRef);
    return this.executeAction(actionDir, step, context);
  }

  /**
   * Execute an action based on its action.yml definition.
   */
  async executeAction(actionDir, step, context) {
    let actionDef;
    try {
      actionDef = this.parseActionYml(actionDir);
    } catch (err) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: err.message,
        outputs: {},
      };
    }

    const actionType = actionDef.runs?.using;

    switch (actionType) {
      case 'composite':
        return this.executeComposite(actionDef, step, context);
      case 'node12':
      case 'node16':
      case 'node20':
        return this.executeNode(actionDir, actionDef, step);
      case 'docker':
        return this.executeDocker(actionDir, actionDef, step);
      default:
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `Unsupported action type: ${actionType}`,
          outputs: {},
        };
    }
  }

  /**
   * Execute a composite action by running its steps.
   */
  async executeComposite(actionDef, step, context) {
    const results = [];

    for (const subStep of actionDef.runs?.steps || []) {
      if (subStep.run) {
        const result = await this.docker.exec(subStep.run, {
          env: { ...step.env, ...subStep.env },
        });
        results.push(result);

        if (result.exitCode !== 0) {
          return {
            success: false,
            exitCode: result.exitCode,
            stdout: results.map(r => r.stdout).join(''),
            stderr: results.map(r => r.stderr).join(''),
            outputs: {},
          };
        }
      }
    }

    return {
      success: true,
      exitCode: 0,
      stdout: results.map(r => r.stdout).join(''),
      stderr: results.map(r => r.stderr).join(''),
      outputs: {},
    };
  }

  /**
   * Execute a Node.js action.
   */
  async executeNode(actionDir, actionDef, step) {
    const main = actionDef.runs?.main;
    if (!main) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Node action missing runs.main',
        outputs: {},
      };
    }

    const entryPoint = join(actionDir, main);

    // Build INPUT_ env vars from step.with
    const inputEnv = {};
    for (const [key, value] of Object.entries(step.with || {})) {
      inputEnv[`INPUT_${key.toUpperCase()}`] = String(value);
    }

    const result = await this.docker.exec(`node ${entryPoint}`, {
      env: { ...step.env, ...inputEnv },
    });

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs: {},
    };
  }

  /**
   * Execute a Docker-based action.
   */
  async executeDocker(actionDir, actionDef, step) {
    // Docker-in-Docker action execution — Phase 2
    return {
      success: true,
      exitCode: 0,
      stdout: `[actionlens] Docker action execution deferred to Phase 2\n`,
      stderr: '',
      outputs: {},
    };
  }
}
