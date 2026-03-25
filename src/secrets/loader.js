import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

/**
 * Load secrets from a .env file and return them as a plain object.
 * Used to populate the `secrets.*` context for expression evaluation.
 *
 * @param {string} [envFilePath='.env'] - Path to the .env file
 * @returns {object} Secrets key-value pairs
 */
export function loadSecrets(envFilePath = '.env') {
  const filePath = resolve(envFilePath);

  if (!existsSync(filePath)) {
    return {};
  }

  const result = config({ path: filePath, override: false });

  if (result.error) {
    throw new Error(`Failed to load secrets from ${filePath}: ${result.error.message}`);
  }

  return result.parsed || {};
}

/**
 * Load secrets from a file without polluting process.env.
 * Parses the .env file manually to extract key-value pairs.
 *
 * @param {string} [envFilePath='.env'] - Path to the .env file
 * @returns {object} Secrets key-value pairs
 */
export function loadSecretsIsolated(envFilePath = '.env') {
  const filePath = resolve(envFilePath);

  if (!existsSync(filePath)) {
    return {};
  }

  const content = readFileSync(filePath, 'utf-8');
  const secrets = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    secrets[key] = value;
  }

  return secrets;
}
