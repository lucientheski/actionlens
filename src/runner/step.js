import { randomUUID } from 'node:crypto';
import { evaluateExpression } from '../parser/expressions.js';

/**
 * Executes a single workflow step inside a Docker container.
 * Handles run: steps, env merging, output parsing, timeouts, and continue-on-error.
 */
export class StepRunner {
  /**
   * @param {import('./docker.js').DockerRunner} dockerRunner
   * @param {object} expressionContext - Context for ${{ }} evaluation
   * @param {object} [options]
   * @param {object} [options.jobEnv] - Job-level environment variables
   * @param {object} [options.workflowEnv] - Workflow-level environment variables
   * @param {import('./actions.js').ActionRunner} [options.actionRunner] - For uses: steps
   */
  constructor(dockerRunner, expressionContext, options = {}) {
    this.docker = dockerRunner;
    this.context = expressionContext;
    this.jobEnv = options.jobEnv || {};
    this.workflowEnv = options.workflowEnv || {};
    this.actionRunner = options.actionRunner || null;
  }

  /**
   * Execute a normalized step.
   *
   * @param {object} step - Normalized step object
   * @param {object} [options]
   * @param {function} [options.onStdout] - Streaming stdout callback
   * @param {function} [options.onStderr] - Streaming stderr callback
   * @returns {{ success: boolean, exitCode: number, stdout: string, stderr: string, outputs: object, skipped: boolean }}
   */
  async run(step, options = {}) {
    // Evaluate the `if` condition
    if (step.if) {
      const condition = evaluateExpression(step.if, this.context);
      if (condition === 'false' || condition === '' || condition === '0') {
        return {
          success: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          outputs: {},
          skipped: true,
        };
      }
    }

    // Merge environment: workflow env → job env → step env (step wins)
    const mergedEnv = {};
    for (const [key, value] of Object.entries(this.workflowEnv)) {
      mergedEnv[key] = evaluateExpression(String(value), this.context);
    }
    for (const [key, value] of Object.entries(this.jobEnv)) {
      mergedEnv[key] = evaluateExpression(String(value), this.context);
    }
    for (const [key, value] of Object.entries(step.env || {})) {
      mergedEnv[key] = evaluateExpression(String(value), this.context);
    }

    if (step.run) {
      return this.runScript(step, mergedEnv, options);
    }

    if (step.uses) {
      return this.runAction(step, mergedEnv);
    }

    throw new Error(`Step ${step.index}: neither 'run' nor 'uses' specified`);
  }

  /**
   * Execute a `run:` step with shell wrapping, GITHUB_OUTPUT support, and timeout.
   */
  async runScript(step, env, options = {}) {
    const script = evaluateExpression(step.run, this.context);
    const shell = step.shell || 'bash';

    // Create a unique file path for GITHUB_OUTPUT inside the container
    const outputFileId = randomUUID().slice(0, 8);
    const githubOutputFile = `/tmp/github_output_${outputFileId}`;
    const githubStateFile = `/tmp/github_state_${outputFileId}`;

    // Inject GITHUB_OUTPUT and GITHUB_STATE env vars
    const execEnv = {
      ...env,
      GITHUB_OUTPUT: githubOutputFile,
      GITHUB_STATE: githubStateFile,
      GITHUB_WORKSPACE: '/github/workspace',
    };

    // Create the output files first
    try {
      await this.docker.exec(['sh', '-c', `touch ${githubOutputFile} ${githubStateFile}`], {
        env: {},
      });
    } catch {
      // Non-fatal — output parsing will just find no file
    }

    const command = wrapInShell(script, shell);

    // Calculate timeout in ms from timeout-minutes
    const timeoutMs = step.timeoutMinutes
      ? step.timeoutMinutes * 60 * 1000
      : 0;

    const execOptions = {
      env: execEnv,
      workdir: step.workingDirectory || undefined,
      timeout: timeoutMs || undefined,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    };

    let result;
    try {
      if (options.onStdout || options.onStderr) {
        result = await this.docker.execStream(command, execOptions);
      } else {
        result = await this.docker.exec(command, execOptions);
      }
    } catch (err) {
      const isTimeout = err.message && err.message.includes('timed out');
      return {
        success: step.continueOnError === true,
        exitCode: isTimeout ? 124 : 1,
        stdout: '',
        stderr: err.message,
        outputs: {},
        skipped: false,
      };
    }

    // Parse outputs from stdout (legacy ::set-output) and GITHUB_OUTPUT file
    const legacyOutputs = parseLegacyOutputs(result.stdout);
    const fileOutputs = await this._readOutputFile(githubOutputFile);
    const outputs = { ...legacyOutputs, ...fileOutputs };

    // Cleanup temp files (best effort)
    try {
      await this.docker.exec(['rm', '-f', githubOutputFile, githubStateFile], { env: {} });
    } catch {
      // Non-fatal
    }

    const success = result.exitCode === 0 || step.continueOnError === true;

    return {
      success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs,
      skipped: false,
    };
  }

  /**
   * Execute a `uses:` action step by delegating to ActionRunner.
   */
  async runAction(step, env) {
    if (!this.actionRunner) {
      return {
        success: true,
        exitCode: 0,
        stdout: `[actionlens] Action '${step.uses}' — no ActionRunner configured\n`,
        stderr: '',
        outputs: {},
        skipped: false,
      };
    }

    return this.actionRunner.run(step, this.context, env);
  }

  /**
   * Read and parse the GITHUB_OUTPUT file from the container.
   * Supports both simple key=value and heredoc delimiter format.
   */
  async _readOutputFile(filePath) {
    const outputs = {};
    try {
      const result = await this.docker.exec(['cat', filePath], { env: {} });
      if (result.exitCode !== 0 || !result.stdout.trim()) return outputs;

      const lines = result.stdout.split('\n');
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];

        // Heredoc format: name<<DELIMITER
        const heredocMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/);
        if (heredocMatch) {
          const [, name, delimiter] = heredocMatch;
          const valueParts = [];
          i++;
          while (i < lines.length && lines[i] !== delimiter) {
            valueParts.push(lines[i]);
            i++;
          }
          outputs[name] = valueParts.join('\n');
          i++; // skip delimiter line
          continue;
        }

        // Simple key=value format
        const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (kvMatch) {
          outputs[kvMatch[1]] = kvMatch[2];
        }

        i++;
      }
    } catch {
      // Non-fatal — file may not exist
    }
    return outputs;
  }
}

/**
 * Wrap a script in the appropriate shell invocation.
 */
function wrapInShell(script, shell) {
  switch (shell) {
    case 'bash':
      return ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c', script];
    case 'sh':
      return ['sh', '-e', '-c', script];
    case 'python':
      return ['python3', '-c', script];
    case 'pwsh':
    case 'powershell':
      return ['pwsh', '-command', script];
    default:
      return ['sh', '-e', '-c', script];
  }
}

/**
 * Parse legacy GitHub Actions `::set-output name=KEY::VALUE` from stdout.
 */
function parseLegacyOutputs(stdout) {
  const outputs = {};
  const regex = /::set-output name=([^:]+)::(.+)/g;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    outputs[match[1]] = match[2];
  }
  return outputs;
}

// Export for testing
export { wrapInShell, parseLegacyOutputs };
