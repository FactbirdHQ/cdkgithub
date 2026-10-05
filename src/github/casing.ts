/**
 * Key-casing conversion at the API boundary.
 *
 * The authoring API and the manifest are camelCase throughout; GitHub's REST
 * payloads are snake_case. Fixed, small payloads (org settings, the Actions
 * policy) are mapped field by field in the client, but rulesets carry a deep,
 * open-ended tree of rules and conditions where a field-by-field mapping would
 * be a hundred lines of transcription. These two functions convert those trees.
 *
 * Only keys are touched. Values — patterns, ref names like `~DEFAULT_BRANCH`,
 * rule discriminators like `pull_request` — pass through untouched.
 */

/** Convert every object key in a JSON tree from camelCase to snake_case. */
export function toSnakeCaseKeys<T>(value: T): T {
  return convert(value, camelToSnake) as T;
}

/** Convert every object key in a JSON tree from snake_case to camelCase. */
export function toCamelCaseKeys<T>(value: unknown): T {
  return convert(value, snakeToCamel) as T;
}

function convert(value: unknown, rename: (key: string) => string): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => convert(v, rename));
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[rename(key)] = convert(v, rename);
  }
  return out;
}

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
