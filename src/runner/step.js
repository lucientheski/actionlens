import { evaluateExpression } from '../parser/expressions.js';

/**
 * Executes a single workflow step inside a Docker container.
 */
export class StepRunner {
  /**
   * @param {import('./docker.js').DockerRunner} dockerRunner
   * @param {object} expressionContext - Context for ${{ }} evaluation
   */
  constructor(dockerRunner, expressionContext) {
    this.docker = dockerRunner;
    this.context = expressionContext;
  }

  /**
   * Execute a normalized step.
   *
   * @param {object} step - Normalized step object
   * @returns {{ success: boolean, exitCode: number, stdout: string, stderr: string, outputs: object }}
   */
  async run(step) {
    // Evaluate the `if` condition
    if (step.if) {
      const condition = evaluateExpression(step.if, this.context);
      if (condition === 'false' || condition === '') {
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

    // Resolve environment variables with expression evaluation
    const env = {};
    for (const [key, value] of Object.entries(step.env)) {
      env[key] = evaluateExpression(String(value), this.context);
    }

    if (step.run) {
      return this.runScript(step, env);
    }

    if (step.uses) {
      // Delegate to ActionRunner (will be wired in Phase 2)
      return {
        success: true,
        exitCode: 0,
        stdout: `[actionlens] Action '${step.uses}' — execution deferred to ActionRunner\n`,
        stderr: '',
        outputs: {},
        skipped: false,
      };
    }

    throw new Error(`Step ${step.index}: neither 'run' nor 'uses' specified`);
  }

  /**
   * Execute a `run:` step.
   */
  async runScript(step, env) {
    const script = evaluateExpression(step.run, this.context);
    const shell = step.shell || 'bash';
    const command = wrapInShell(script, shell);

    const execOptions = {
      env,
      workdir: step.workingDirectory,
    };

    const result = await this.docker.exec(command, execOptions);
    const outputs = parseOutputs(result.stdout);
    const success = result.exitCode === 0 || step.continueOnError;

    return {
      success,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputs,
      skipped: false,
    };
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
    default:
      return ['sh', '-e', '-c', script];
  }
}

/**
 * Parse GitHub Actions `::set-output` and `GITHUB_OUTPUT` style outputs from stdout.
 *
 * @param {string} stdout
 * @returns {object} Parsed outputs
 */
function parseOutputs(stdout) {
  const outputs = {};

  // Legacy ::set-output format
  const legacyRegex = /::set-output name=([^:]+)::(.+)/g;
  let match;
  while ((match = legacyRegex.exec(stdout)) !== null) {
    outputs[match[1]] = match[2];
  }

  // Modern GITHUB_OUTPUT format (key=value lines, simplified)
  // Full support for delimiters will come in Phase 2
  const modernRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/gm;
  while ((match = modernRegex.exec(stdout)) !== null) {
    // Only capture if not already set by legacy format
    if (!(match[1] in outputs) && !match[0].startsWith('::')) {
      // Skip this in Phase 1 to avoid false positives — real GITHUB_OUTPUT
      // parsing needs file-based detection
    }
  }

  return outputs;
}
