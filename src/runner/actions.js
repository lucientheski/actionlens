import { resolve, join } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import yaml from 'js-yaml';
import { evaluateExpression } from '../parser/expressions.js';

/**
 * Common actions that get special handling instead of full clone+execute.
 */
const COMMON_ACTION_SHORTCUTS = {
  'actions/checkout': {
    handler: async (_step, _context, _env, _docker) => ({
      success: true,
      exitCode: 0,
      stdout: '[actionlens] actions/checkout — workspace already mounted, skipping clone\n',
      stderr: '',
      outputs: {},
      skipped: false,
    }),
  },
  'actions/cache': {
    handler: async (_step, _context, _env, _docker) => ({
      success: true,
      exitCode: 0,
      stdout: '[actionlens] actions/cache — caching is a no-op in local debug mode\n',
      stderr: '',
      outputs: { 'cache-hit': 'false' },
      skipped: false,
    }),
  },
  'actions/upload-artifact': {
    handler: async (_step, _context, _env, _docker) => ({
      success: true,
      exitCode: 0,
      stdout: '[actionlens] actions/upload-artifact — no-op in local debug mode\n',
      stderr: '',
      outputs: {},
      skipped: false,
    }),
  },
  'actions/download-artifact': {
    handler: async (_step, _context, _env, _docker) => ({
      success: true,
      exitCode: 0,
      stdout: '[actionlens] actions/download-artifact — no-op in local debug mode\n',
      stderr: '',
      outputs: {},
      skipped: false,
    }),
  },
  'actions/setup-node': {
    handler: async (step, _context, _env, docker) => {
      const nodeVersion = step.with?.['node-version'] || '18';
      const major = String(nodeVersion).replace(/\..*/, '');
      try {
        // Check if node is already available
        const check = await docker.exec(['node', '--version'], { env: {} });
        if (check.exitCode === 0) {
          return {
            success: true,
            exitCode: 0,
            stdout: `[actionlens] actions/setup-node — node already available: ${check.stdout.trim()}\n`,
            stderr: '',
            outputs: {},
            skipped: false,
          };
        }
      } catch {
        // Node not available, try to install
      }
      try {
        const result = await docker.exec(
          ['sh', '-c', `apt-get update -qq && apt-get install -y -qq nodejs npm 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash - && apt-get install -y nodejs)`],
          { env: {} }
        );
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: `[actionlens] actions/setup-node — installing node ${major}\n${result.stdout}`,
          stderr: result.stderr,
          outputs: {},
          skipped: false,
        };
      } catch (err) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `[actionlens] actions/setup-node — failed: ${err.message}\n`,
          outputs: {},
          skipped: false,
        };
      }
    },
  },
  'actions/setup-python': {
    handler: async (_step, _context, _env, docker) => {
      try {
        const check = await docker.exec(['python3', '--version'], { env: {} });
        if (check.exitCode === 0) {
          return {
            success: true,
            exitCode: 0,
            stdout: `[actionlens] actions/setup-python — python already available: ${check.stdout.trim()}\n`,
            stderr: '',
            outputs: {},
            skipped: false,
          };
        }
      } catch {
        // not available
      }
      try {
        const result = await docker.exec(
          ['sh', '-c', 'apt-get update -qq && apt-get install -y -qq python3 python3-pip 2>&1'],
          { env: {} }
        );
        return {
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: `[actionlens] actions/setup-python — installing python3\n${result.stdout}`,
          stderr: result.stderr,
          outputs: {},
          skipped: false,
        };
      } catch (err) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `[actionlens] actions/setup-python — failed: ${err.message}\n`,
          outputs: {},
          skipped: false,
        };
      }
    },
  },
};

/**
 * Handles cloning, parsing, and executing `uses:` actions.
 * Supports GitHub-hosted actions (owner/repo@ref), local actions (./path),
 * composite actions, node actions, and docker actions.
 */
export class ActionRunner {
  /**
   * @param {import('./docker.js').DockerRunner} dockerRunner
   * @param {object} [options]
   * @param {string} [options.cacheDir] - Directory to cache cloned actions
   * @param {string} [options.workspace] - Workspace root for local action resolution
   */
  constructor(dockerRunner, options = {}) {
    this.docker = dockerRunner;
    this.cacheDir = options.cacheDir || resolve('.actionlens/actions-cache');
    this.workspace = options.workspace || process.cwd();
  }

  /**
   * Execute a `uses:` action step.
   *
   * @param {object} step - Normalized step with `uses` field
   * @param {object} context - Expression context
   * @param {object} [env] - Merged environment variables
   * @returns {{ success: boolean, exitCode: number, stdout: string, stderr: string, outputs: object, skipped: boolean }}
   */
  async run(step, context, env = {}) {
    const actionRef = step.uses;

    // Check for common action shortcuts
    const shortcut = this._findShortcut(actionRef);
    if (shortcut) {
      return shortcut.handler(step, context, env, this.docker);
    }

    if (actionRef.startsWith('./') || actionRef.startsWith('../')) {
      return this.runLocalAction(actionRef, step, context, env);
    }

    return this.runRemoteAction(actionRef, step, context, env);
  }

  /**
   * Check if an action ref matches a common shortcut.
   * Matches "actions/checkout@v4" → "actions/checkout".
   */
  _findShortcut(actionRef) {
    const [repoPath] = actionRef.split('@');
    return COMMON_ACTION_SHORTCUTS[repoPath] || null;
  }

  /**
   * Parse an action reference like "actions/checkout@v4" into parts.
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
   */
  cloneAction(parsed) {
    const destDir = join(this.cacheDir, parsed.owner, parsed.repo, parsed.ref);

    if (existsSync(join(destDir, 'action.yml')) || existsSync(join(destDir, 'action.yaml'))) {
      return destDir;
    }

    mkdirSync(destDir, { recursive: true });

    const repoUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    try {
      execSync(
        `git clone --depth 1 --branch ${parsed.ref} ${repoUrl} ${destDir}`,
        { stdio: 'pipe', timeout: 60000 }
      );
    } catch (err) {
      throw new Error(`git clone failed for ${parsed.owner}/${parsed.repo}@${parsed.ref}: ${err.message}`);
    }

    return destDir;
  }

  /**
   * Read and parse an action.yml or action.yaml from a directory.
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
  async runRemoteAction(actionRef, step, context, env) {
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
        skipped: false,
      };
    }

    if (parsed.path) {
      actionDir = join(actionDir, parsed.path);
    }

    return this.executeAction(actionDir, step, context, env);
  }

  /**
   * Execute a local action (./path reference).
   */
  async runLocalAction(actionRef, step, context, env) {
    const actionDir = resolve(this.workspace, actionRef);
    return this.executeAction(actionDir, step, context, env);
  }

  /**
   * Execute an action based on its action.yml definition.
   */
  async executeAction(actionDir, step, context, env) {
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
        skipped: false,
      };
    }

    const actionType = actionDef.runs?.using;

    switch (actionType) {
      case 'composite':
        return this.executeComposite(actionDef, step, context, env);
      case 'node12':
      case 'node16':
      case 'node20':
        return this.executeNode(actionDir, actionDef, step, env);
      case 'docker':
        return this.executeDocker(actionDir, actionDef, step, env);
      default:
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `Unsupported action type: ${actionType}`,
          outputs: {},
          skipped: false,
        };
    }
  }

  /**
   * Build INPUT_* env vars from step.with, applying defaults from action inputs.
   */
  _buildInputEnv(step, actionDef, context) {
    const inputEnv = {};
    const inputs = actionDef.inputs || {};

    // Apply defaults first
    for (const [name, def] of Object.entries(inputs)) {
      if (def.default !== undefined) {
        inputEnv[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] = String(def.default);
      }
    }

    // Override with step.with values
    for (const [key, value] of Object.entries(step.with || {})) {
      const resolved = evaluateExpression(String(value), context);
      inputEnv[`INPUT_${key.toUpperCase().replace(/-/g, '_')}`] = resolved;
    }

    return inputEnv;
  }

  /**
   * Execute a composite action by recursively running its steps.
   */
  async executeComposite(actionDef, step, context, env) {
    const allStdout = [];
    const allStderr = [];
    const outputs = {};
    const inputEnv = this._buildInputEnv(step, actionDef, context);

    for (const subStep of actionDef.runs?.steps || []) {
      const stepEnv = {
        ...env,
        ...inputEnv,
        ...(subStep.env || {}),
      };

      if (subStep.uses) {
        // Recursive action execution
        const subResult = await this.run(
          { uses: subStep.uses, with: subStep.with || {}, env: subStep.env || {}, index: -1 },
          context,
          stepEnv
        );
        allStdout.push(subResult.stdout);
        allStderr.push(subResult.stderr);
        if (!subResult.success) {
          return {
            success: false,
            exitCode: subResult.exitCode,
            stdout: allStdout.join(''),
            stderr: allStderr.join(''),
            outputs,
            skipped: false,
          };
        }
        continue;
      }

      if (subStep.run) {
        const shell = subStep.shell || 'bash';
        const script = evaluateExpression(subStep.run, context);
        const command = wrapCompositeShell(script, shell);

        const envArray = stepEnv;
        const result = await this.docker.exec(command, { env: envArray });
        allStdout.push(result.stdout);
        allStderr.push(result.stderr);

        if (result.exitCode !== 0) {
          return {
            success: false,
            exitCode: result.exitCode,
            stdout: allStdout.join(''),
            stderr: allStderr.join(''),
            outputs,
            skipped: false,
          };
        }
      }
    }

    // Resolve action outputs from the action.yml outputs section
    if (actionDef.outputs) {
      for (const [name, def] of Object.entries(actionDef.outputs)) {
        if (def.value) {
          outputs[name] = evaluateExpression(def.value, context);
        }
      }
    }

    return {
      success: true,
      exitCode: 0,
      stdout: allStdout.join(''),
      stderr: allStderr.join(''),
      outputs,
      skipped: false,
    };
  }

  /**
   * Execute a Node.js action with proper @actions/core env var interface.
   */
  async executeNode(actionDir, actionDef, step, env) {
    const main = actionDef.runs?.main;
    if (!main) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Node action missing runs.main',
        outputs: {},
        skipped: false,
      };
    }

    const entryPoint = join(actionDir, main);

    if (!existsSync(entryPoint)) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Node action entry point not found: ${entryPoint}`,
        outputs: {},
        skipped: false,
      };
    }

    // Build INPUT_ env vars from step.with with defaults
    const inputEnv = this._buildInputEnv(step, actionDef, {});

    // Set up @actions/core compatible env vars
    const githubOutputFile = `/tmp/action_output_${Date.now()}`;
    const githubStateFile = `/tmp/action_state_${Date.now()}`;

    const actionEnv = {
      ...env,
      ...inputEnv,
      GITHUB_OUTPUT: githubOutputFile,
      GITHUB_STATE: githubStateFile,
      GITHUB_WORKSPACE: '/github/workspace',
      GITHUB_ACTION: step.id || '_run',
      GITHUB_ACTION_PATH: actionDir,
    };

    // Create output files
    try {
      await this.docker.exec(['sh', '-c', `touch ${githubOutputFile} ${githubStateFile}`], { env: {} });
    } catch {
      // Non-fatal
    }

    const result = await this.docker.exec(['node', entryPoint], {
      env: actionEnv,
    });

    // Parse outputs from GITHUB_OUTPUT file
    const outputs = {};
    try {
      const outResult = await this.docker.exec(['cat', githubOutputFile], { env: {} });
      if (outResult.exitCode === 0 && outResult.stdout.trim()) {
        for (const line of outResult.stdout.split('\n')) {
          const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
          if (match) outputs[match[1]] = match[2];
        }
      }
    } catch {
      // Non-fatal
    }

    // Also parse legacy outputs from stdout
    const legacyRegex = /::set-output name=([^:]+)::(.+)/g;
    let match;
    while ((match = legacyRegex.exec(result.stdout)) !== null) {
      outputs[match[1]] = match[2];
    }

    // Cleanup
    try {
      await this.docker.exec(['rm', '-f', githubOutputFile, githubStateFile], { env: {} });
    } catch {
      // Non-fatal
    }

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs,
      skipped: false,
    };
  }

  /**
   * Execute a Docker-based action.
   * Builds or pulls the action's Docker image, runs it with inputs as env vars.
   */
  async executeDocker(actionDir, actionDef, step, env) {
    const image = actionDef.runs?.image;
    if (!image) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'Docker action missing runs.image',
        outputs: {},
        skipped: false,
      };
    }

    const inputEnv = this._buildInputEnv(step, actionDef, {});
    const actionEnv = { ...env, ...inputEnv };

    let dockerImage;

    if (image === 'Dockerfile' || image.startsWith('Dockerfile')) {
      // Build from Dockerfile in action directory
      const dockerfilePath = join(actionDir, image);
      if (!existsSync(join(actionDir, 'Dockerfile')) && !existsSync(dockerfilePath)) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `Dockerfile not found in ${actionDir}`,
          outputs: {},
          skipped: false,
        };
      }

      const tag = `actionlens-action-${Date.now()}`;
      try {
        execSync(`docker build -t ${tag} ${actionDir}`, { stdio: 'pipe', timeout: 300000 });
        dockerImage = tag;
      } catch (err) {
        return {
          success: false,
          exitCode: 1,
          stdout: '',
          stderr: `Docker build failed: ${err.message}`,
          outputs: {},
          skipped: false,
        };
      }
    } else if (image.startsWith('docker://')) {
      dockerImage = image.replace('docker://', '');
    } else {
      dockerImage = image;
    }

    // Run the docker action's entrypoint
    const args = actionDef.runs?.args || [];
    const entrypoint = actionDef.runs?.entrypoint;

    const envArray = Object.entries(actionEnv).map(([k, v]) => `-e ${k}=${v}`).join(' ');
    const argsStr = args.map(a => `'${a}'`).join(' ');

    let cmd = `docker run --rm`;
    if (entrypoint) cmd += ` --entrypoint '${entrypoint}'`;
    cmd += ` ${envArray} ${dockerImage} ${argsStr}`;

    try {
      const result = await this.docker.exec(['sh', '-c', cmd], { env: actionEnv });
      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        outputs: {},
        skipped: false,
      };
    } catch (err) {
      return {
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: `Docker action execution failed: ${err.message}`,
        outputs: {},
        skipped: false,
      };
    }
  }
}

/**
 * Wrap script for composite action shell execution.
 */
function wrapCompositeShell(script, shell) {
  switch (shell) {
    case 'bash':
      return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script];
    case 'sh':
      return ['sh', '-e', '-c', script];
    case 'python':
      return ['python3', '-c', script];
    default:
      return ['sh', '-e', '-c', script];
  }
}

export { COMMON_ACTION_SHORTCUTS };
