import yaml from 'js-yaml';

/**
 * Parse a GitHub Actions workflow YAML string into a normalized structure.
 *
 * @param {string} content - Raw YAML content
 * @returns {{ name: string, on: object, env: object, jobs: Object<string, NormalizedJob> }}
 */
export function parseWorkflow(content) {
  const doc = yaml.load(content);

  if (!doc || typeof doc !== 'object') {
    throw new Error('Invalid workflow: YAML did not produce an object');
  }

  if (!doc.jobs || typeof doc.jobs !== 'object') {
    throw new Error('Invalid workflow: missing "jobs" section');
  }

  const name = doc.name || 'Unnamed workflow';
  const on = normalizeOn(doc.on || doc.true); // yaml parses bare `on:` key oddly
  const env = doc.env || {};

  const jobs = {};
  for (const [jobId, jobDef] of Object.entries(doc.jobs)) {
    jobs[jobId] = normalizeJob(jobId, jobDef);
  }

  return { name, on, env, jobs };
}

/**
 * Normalize the `on` trigger field which can be a string, array, or object.
 */
function normalizeOn(on) {
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) {
    const result = {};
    for (const event of on) result[event] = {};
    return result;
  }
  return on || {};
}

/**
 * Normalize a single job definition.
 */
function normalizeJob(id, jobDef) {
  const runsOn = jobDef['runs-on'] || 'ubuntu-latest';
  const needs = Array.isArray(jobDef.needs)
    ? jobDef.needs
    : jobDef.needs
      ? [jobDef.needs]
      : [];
  const env = jobDef.env || {};
  const ifCondition = jobDef.if || null;

  const steps = (jobDef.steps || []).map((step, index) => normalizeStep(step, index));

  return { id, runsOn, needs, env, if: ifCondition, steps };
}

/**
 * Normalize a single step definition.
 *
 * @param {object} step - Raw step object from YAML
 * @param {number} index - Step index within the job
 * @returns {NormalizedStep}
 */
export function normalizeStep(step, index) {
  return {
    index,
    id: step.id || null,
    name: step.name || null,
    uses: step.uses || null,
    run: step.run || null,
    with: step.with || {},
    env: step.env || {},
    if: step.if || null,
    workingDirectory: step['working-directory'] || null,
    shell: step.shell || null,
    continueOnError: step['continue-on-error'] || false,
  };
}
