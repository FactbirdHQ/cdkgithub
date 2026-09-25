import type {
  LiveOrgSecret,
  LiveOrgVariable,
  LiveRunnerGroup,
} from '../github/client.ts';
import type {
  ActionsSecretManifest,
  ActionsVariableManifest,
  DesiredState,
  RunnerGroupManifest,
} from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';
import { scopesOf } from './owned-scopes.ts';
import { diffDeclared } from './plan-governance.ts';
import { matchesSubset } from './subset.ts';

/**
 * Diff the Actions administration surfaces: runner groups, and the secrets and
 * variables of every scope the definition declares one on.
 *
 * Secrets and variables share the same scoping rule: the organization owns its
 * own, a declared repository owns its own, and so does a repository an entry
 * names, whether or not any entry is left in the scope. Pruning never reaches a
 * repository the definition does not mention.
 * GitHub compares the names case-insensitively and reports them uppercased, so
 * the matching here does the same rather than proposing to recreate `token`
 * because the live listing says `TOKEN`.
 */
export function planActionsAdmin(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  return [
    ...planRunnerGroups(desired.runnerGroups, live),
    ...planVariables(desired.actionsVariables, desired, live),
    ...planSecrets(desired.actionsSecrets, desired, live),
  ];
}

// ---------------------------------------------------------------------------
// Runner groups
// ---------------------------------------------------------------------------

function planRunnerGroups(
  groups: RunnerGroupManifest[] | undefined,
  live: LiveState,
): Change[] {
  if (!groups) return [];

  const liveGroups = live.runnerGroups ?? [];
  const liveByName = new Map(liveGroups.map((g) => [g.name, g]));
  const changes: Change[] = [];

  for (const group of groups) {
    const current = liveByName.get(group.name);
    if (!current) {
      changes.push({ kind: 'create-runner-group', group });
      continue;
    }
    const fields = diffRunnerGroup(group, current);
    if (fields.length > 0) {
      changes.push({ kind: 'update-runner-group', id: current.id, group, fields });
    }
  }

  const declared = new Set(groups.map((g) => g.name));
  for (const current of liveGroups) {
    // GitHub refuses to delete its built-in group, so proposing it would only
    // ever produce a failing change.
    if (!declared.has(current.name) && !current.isDefault) {
      changes.push({ kind: 'delete-runner-group', live: current });
    }
  }

  return changes;
}

function diffRunnerGroup(
  desired: RunnerGroupManifest,
  live: LiveRunnerGroup,
): FieldChange[] {
  const { name: _name, selectedRepositories, ...rest } = desired;
  const fields = diffDeclared(rest, live);

  // The repository list is its own endpoint and a set, like the Actions
  // policy's selected repositories.
  if (selectedRepositories) {
    const liveRepos = live.selectedRepositories ?? [];
    if (!matchesSubset(selectedRepositories, liveRepos)) {
      fields.push({
        field: 'selectedRepositories',
        from: liveRepos,
        to: selectedRepositories,
      });
    }
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

function planVariables(
  declared: ActionsVariableManifest[] | undefined,
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const variables = declared ?? [];
  const scopes = scopesOf(variables, desired);
  const changes: Change[] = [];

  const orgDeclared = variables.filter((v) => v.repository === undefined);
  if (scopes.organization) {
    const liveVariables = live.actionsVariables ?? [];
    const liveByName = byUpperName(liveVariables);

    for (const variable of orgDeclared) {
      const current = liveByName.get(variable.name.toUpperCase());
      if (!current) {
        changes.push({ kind: 'create-variable', variable });
        continue;
      }
      const fields = diffOrgVariable(variable, current);
      if (fields.length > 0) {
        changes.push({ kind: 'update-variable', variable, fields });
      }
    }

    const declared = upperNames(orgDeclared);
    for (const current of liveVariables) {
      if (!declared.has(current.name.toUpperCase())) {
        changes.push({ kind: 'delete-variable', name: current.name });
      }
    }
  }

  const wantedVariables = byRepository(variables);
  for (const repository of scopes.repositories) {
    const wanted = wantedVariables.get(repository) ?? [];
    const liveVariables = (live.repositoryVariables ?? []).filter(
      (v) => v.repository === repository,
    );
    const liveByName = byUpperName(liveVariables);

    for (const variable of wanted) {
      const current = liveByName.get(variable.name.toUpperCase());
      if (!current) {
        changes.push({ kind: 'create-variable', variable });
      } else if (current.value !== variable.value) {
        changes.push({
          kind: 'update-variable',
          variable,
          fields: [
            { field: 'value', from: current.value, to: variable.value },
          ],
        });
      }
    }

    const declared = upperNames(wanted);
    for (const current of liveVariables) {
      if (!declared.has(current.name.toUpperCase())) {
        changes.push({
          kind: 'delete-variable',
          name: current.name,
          repository,
        });
      }
    }
  }

  return changes;
}

function diffOrgVariable(
  desired: ActionsVariableManifest,
  live: LiveOrgVariable,
): FieldChange[] {
  const fields: FieldChange[] = [];
  if (desired.value !== live.value) {
    fields.push({ field: 'value', from: live.value, to: desired.value });
  }
  if (desired.visibility !== live.visibility) {
    fields.push({
      field: 'visibility',
      from: live.visibility,
      to: desired.visibility,
    });
  }
  if (desired.selectedRepositories) {
    const liveRepos = live.selectedRepositories ?? [];
    if (!matchesSubset(desired.selectedRepositories, liveRepos)) {
      fields.push({
        field: 'selectedRepositories',
        from: liveRepos,
        to: desired.selectedRepositories,
      });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * A secret diffs on what GitHub can report: existence, and for an organization
 * secret its visibility. The value is invisible on both sides, so a secret
 * that exists with matching visibility is a match. Rotating a value in place
 * is done by changing any declared field, or by deleting and redeclaring it.
 */
function planSecrets(
  declared: ActionsSecretManifest[] | undefined,
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const secrets = declared ?? [];
  const scopes = scopesOf(secrets, desired);
  const changes: Change[] = [];

  const orgDeclared = secrets.filter((s) => s.repository === undefined);
  if (scopes.organization) {
    const liveSecrets = live.actionsSecrets ?? [];
    const liveByName = byUpperName(liveSecrets);

    for (const secret of orgDeclared) {
      const current = liveByName.get(secret.name.toUpperCase());
      if (!current) {
        changes.push({ kind: 'put-secret', secret, fields: [], exists: false });
        continue;
      }
      const fields = diffOrgSecret(secret, current);
      if (fields.length > 0) {
        changes.push({ kind: 'put-secret', secret, fields, exists: true });
      }
    }

    const declared = upperNames(orgDeclared);
    for (const current of liveSecrets) {
      if (!declared.has(current.name.toUpperCase())) {
        changes.push({ kind: 'delete-secret', name: current.name });
      }
    }
  }

  const wantedSecrets = byRepository(secrets);
  for (const repository of scopes.repositories) {
    const wanted = wantedSecrets.get(repository) ?? [];
    const liveSecrets = (live.repositorySecrets ?? []).filter(
      (s) => s.repository === repository,
    );
    const liveNames = upperNames(liveSecrets);

    for (const secret of wanted) {
      if (!liveNames.has(secret.name.toUpperCase())) {
        changes.push({ kind: 'put-secret', secret, fields: [], exists: false });
      }
    }

    const declared = upperNames(wanted);
    for (const current of liveSecrets) {
      if (!declared.has(current.name.toUpperCase())) {
        changes.push({
          kind: 'delete-secret',
          name: current.name,
          repository,
        });
      }
    }
  }

  return changes;
}

function diffOrgSecret(
  desired: ActionsSecretManifest,
  live: LiveOrgSecret,
): FieldChange[] {
  const fields: FieldChange[] = [];
  if (desired.visibility !== live.visibility) {
    fields.push({
      field: 'visibility',
      from: live.visibility,
      to: desired.visibility,
    });
  }
  if (desired.selectedRepositories) {
    const liveRepos = live.selectedRepositories ?? [];
    if (!matchesSubset(desired.selectedRepositories, liveRepos)) {
      fields.push({
        field: 'selectedRepositories',
        from: liveRepos,
        to: desired.selectedRepositories,
      });
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Shared scoping helpers
// ---------------------------------------------------------------------------

function byRepository<T extends { repository?: string }>(
  items: T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    if (!item.repository) continue;
    const group = groups.get(item.repository) ?? [];
    group.push(item);
    groups.set(item.repository, group);
  }
  return groups;
}

function byUpperName<T extends { name: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name.toUpperCase(), item]));
}

function upperNames(items: ReadonlyArray<{ name: string }>): Set<string> {
  return new Set(items.map((item) => item.name.toUpperCase()));
}
