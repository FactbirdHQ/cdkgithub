import type { DesiredState } from './manifest.ts';

/**
 * Check that a parsed manifest has the shape `plan` and `apply` assume.
 *
 * The manifest is the sole input the reconciler trusts, and every live team
 * absent from it is a delete candidate. A truncated file, a hand edit, or a
 * JSON document from some other tool must therefore fail here, before a plan
 * is computed against a desired state emptier than anyone wrote.
 *
 * Validation is structural, not exhaustive: it pins the fields the planner
 * dereferences and the ones whose absence silently widens the plan.
 */
export function validateManifest(value: unknown, path: string): DesiredState {
  const fail = (problem: string): never => {
    throw new Error(`Manifest at "${path}" is not usable: ${problem}`);
  };

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('expected a JSON object.');
  }
  const state = value as Record<string, unknown>;

  if (typeof state.owner !== 'string' || state.owner.trim() === '') {
    fail('"owner" must be a non-empty string.');
  }
  if (state.ownerType !== 'organization' && state.ownerType !== 'user') {
    fail('"ownerType" must be "organization" or "user".');
  }
  if (!Array.isArray(state.teams)) {
    fail('"teams" must be an array (an empty one means no teams are managed).');
  }

  for (const [index, team] of (state.teams as unknown[]).entries()) {
    const where = `teams[${index}]`;
    if (typeof team !== 'object' || team === null) {
      fail(`${where} must be an object.`);
    }
    const t = team as Record<string, unknown>;
    if (typeof t.slug !== 'string' || t.slug === '') {
      fail(`${where} needs a non-empty "slug".`);
    }
    if (typeof t.name !== 'string' || t.name === '') {
      fail(`${where} ("${t.slug}") needs a non-empty "name".`);
    }
    if (t.privacy !== 'closed' && t.privacy !== 'secret') {
      fail(`${where} ("${t.slug}") needs "privacy" of "closed" or "secret".`);
    }
    for (const list of ['members', 'maintainers'] as const) {
      if (t[list] === undefined) continue;
      if (
        !Array.isArray(t[list]) ||
        (t[list] as unknown[]).some((m) => typeof m !== 'string')
      ) {
        fail(`${where} ("${t.slug}") "${list}" must be an array of usernames.`);
      }
    }
    if (t.repositories !== undefined) {
      if (
        typeof t.repositories !== 'object' ||
        t.repositories === null ||
        Array.isArray(t.repositories) ||
        Object.values(t.repositories).some((p) => typeof p !== 'string')
      ) {
        fail(
          `${where} ("${t.slug}") "repositories" must map repository names to permissions.`,
        );
      }
    }
  }

  // `scim` is what the scim command dereferences, so its fields are pinned
  // here the way the team fields are.
  if (state.scim !== undefined) {
    if (
      typeof state.scim !== 'object' ||
      state.scim === null ||
      Array.isArray(state.scim)
    ) {
      fail('"scim" must be an object when present.');
    }
    const scim = state.scim as Record<string, unknown>;
    for (const field of [
      'tenantId',
      'applicationDisplayName',
      'tokenFrom',
    ] as const) {
      if (typeof scim[field] !== 'string' || scim[field] === '') {
        fail(`"scim" needs a non-empty "${field}".`);
      }
    }
    if (
      !Array.isArray(scim.groups) ||
      scim.groups.length === 0 ||
      scim.groups.some((g) => typeof g !== 'string')
    ) {
      fail('"scim" needs "groups": a non-empty array of group names.');
    }
  }

  // The governance collections are arrays when present; their per-entry shapes
  // are diffed field-by-field and fail loudly on their own.
  for (const collection of [
    'repositories',
    'customRepositoryRoles',
    'organizationRoles',
    'rulesets',
    'repositoryRulesets',
    'runnerGroups',
    'actionsVariables',
    'actionsSecrets',
    'environments',
    'collaborators',
    'codeSecurityConfigurations',
    'customProperties',
    'branchProtection',
  ] as const) {
    if (state[collection] !== undefined && !Array.isArray(state[collection])) {
      fail(`"${collection}" must be an array when present.`);
    }
  }

  return value as DesiredState;
}
