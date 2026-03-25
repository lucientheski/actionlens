/**
 * GitHub Actions expression evaluator.
 * Handles ${{ <expression> }} syntax with support for:
 *   - env.*, secrets.*, github.*, steps.*.outputs.*
 *   - Simple property access (dot notation)
 *   - String literals and concatenation
 */

/**
 * Create a context object for expression evaluation.
 *
 * @param {object} options
 * @param {object} [options.env] - Environment variables
 * @param {object} [options.secrets] - Secrets
 * @param {object} [options.github] - GitHub context (event_name, sha, ref, etc.)
 * @param {object} [options.steps] - Step outputs keyed by step id
 * @param {object} [options.inputs] - Workflow inputs
 * @param {object} [options.matrix] - Matrix values
 * @returns {object} Expression context
 */
export function createExpressionContext({
  env = {},
  secrets = {},
  github = {},
  steps = {},
  inputs = {},
  matrix = {},
} = {}) {
  return { env, secrets, github, steps, inputs, matrix };
}

/**
 * Evaluate all ${{ }} expressions in a string, replacing them with their resolved values.
 *
 * @param {string} input - String potentially containing ${{ }} expressions
 * @param {object} context - Expression context from createExpressionContext
 * @returns {string} String with all expressions resolved
 */
export function evaluateExpression(input, context) {
  if (typeof input !== 'string') return input;

  return input.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, expr) => {
    return resolveExpression(expr.trim(), context);
  });
}

/**
 * Resolve a single expression (the part inside ${{ }}).
 *
 * @param {string} expr - Expression string (e.g., "env.FOO", "secrets.TOKEN")
 * @param {object} context - Expression context
 * @returns {string} Resolved value
 */
function resolveExpression(expr, context) {
  // Handle string literals: 'some string'
  if (expr.startsWith("'") && expr.endsWith("'")) {
    return expr.slice(1, -1);
  }

  // Handle format() function: format('{0}/{1}', a, b)
  const formatMatch = expr.match(/^format\(\s*'([^']*)'\s*,\s*(.*)\)$/);
  if (formatMatch) {
    const [, template, argsStr] = formatMatch;
    const args = argsStr.split(',').map(a => resolveExpression(a.trim(), context));
    return template.replace(/\{(\d+)\}/g, (_, i) => args[parseInt(i)] ?? '');
  }

  // Handle contains() function
  const containsMatch = expr.match(/^contains\(\s*(.*?)\s*,\s*(.*?)\s*\)$/);
  if (containsMatch) {
    const haystack = String(resolveExpression(containsMatch[1].trim(), context)).toLowerCase();
    const needle = String(resolveExpression(containsMatch[2].trim(), context)).toLowerCase();
    return String(haystack.includes(needle));
  }

  // Handle startsWith() function
  const startsWithMatch = expr.match(/^startsWith\(\s*(.*?)\s*,\s*(.*?)\s*\)$/);
  if (startsWithMatch) {
    const str = String(resolveExpression(startsWithMatch[1].trim(), context)).toLowerCase();
    const prefix = String(resolveExpression(startsWithMatch[2].trim(), context)).toLowerCase();
    return String(str.startsWith(prefix));
  }

  // Handle simple dot-path property access: env.FOO, secrets.BAR, github.event_name
  const value = resolveDotPath(expr, context);
  if (value !== undefined) {
    return String(value);
  }

  // Unresolved — return empty string (matches GitHub Actions behavior)
  return '';
}

/**
 * Resolve a dot-separated path against the context object.
 * e.g., "steps.build.outputs.artifact" → context.steps.build.outputs.artifact
 *
 * @param {string} path - Dot-separated path
 * @param {object} context - Context object
 * @returns {*} Resolved value or undefined
 */
function resolveDotPath(path, context) {
  const parts = path.split('.');
  let current = context;

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }

  return current;
}
