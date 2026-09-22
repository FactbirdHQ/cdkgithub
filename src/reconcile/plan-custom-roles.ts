/**
 * Diff the repository roles this organization defines.
 *
 * Identity is the name, which is also the string a team writes to grant through
 * the role, so a rename reads as delete-and-create and would take every grant
 * with it. Nothing here renames; a new name is a new role.
 *
 * Deleting is gated behind `--allow-delete` for the same reason: teams hold
 * access through a custom role, and removing it removes their access rather
 * than falling back to the base.
 */

import type { LiveCustomRepositoryRole } from '../github/client.ts';
import { comparableRoleName } from '../github/client.ts';
import type { CustomRepositoryRoleManifest } from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';

export function planCustomRepositoryRoles(
  desired: CustomRepositoryRoleManifest[] | undefined,
  live: LiveState,
): Change[] {
  if (!desired) return [];

  const liveByName = new Map(
    (live.customRepositoryRoles ?? []).map((r) => [r.name, r]),
  );
  const declared = new Set(desired.map((r) => r.name));
  const changes: Change[] = [];

  for (const role of desired) {
    const current = liveByName.get(role.name);
    if (!current) {
      changes.push({ kind: 'create-repo-role', role });
      continue;
    }
    const fields = diff(role, current);
    if (fields.length > 0) {
      changes.push({
        kind: 'update-repo-role',
        id: current.id,
        role,
        fields,
      });
    }
  }

  for (const current of liveByName.values()) {
    if (declared.has(current.name)) continue;
    changes.push({ kind: 'delete-repo-role', live: current });
  }

  return changes;
}

function diff(
  desired: CustomRepositoryRoleManifest,
  live: LiveCustomRepositoryRole,
): FieldChange[] {
  const fields: FieldChange[] = [];

  // GitHub answers `write` where a grant is written `push`, the same two words
  // that disagree everywhere else here. Compare them in one vocabulary.
  const liveBase = comparableRoleName(live.baseRole);
  if (desired.baseRole !== liveBase) {
    fields.push({ field: 'baseRole', from: liveBase, to: desired.baseRole });
  }
  if (desired.description !== (live.description ?? '')) {
    fields.push({
      field: 'description',
      from: live.description ?? '',
      to: desired.description,
    });
  }

  // Order carries no meaning here, so compare them as sets.
  const wanted = [...desired.permissions].sort();
  const held = [...live.permissions].sort();
  if (wanted.join(',') !== held.join(',')) {
    fields.push({ field: 'permissions', from: held, to: wanted });
  }

  return fields;
}
