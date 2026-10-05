import { comparableRoleName } from '../github/client.ts';
import type { DesiredState } from '../synth/manifest.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';

/**
 * Diff direct collaborators. Unmanaged until the definition declares one; from
 * then on every declared repository owns its collaborators and pending
 * invitations, so one nobody declared is a gated removal. Logins compare
 * case-insensitively, the way GitHub treats them, and permissions compare in
 * the request vocabulary, so a declared `push` matches a live `write`.
 */
export function planCollaborators(desired: DesiredState, live: LiveState): Change[] {
  if (!desired.collaborators) {
    return [];
  }
  const changes: Change[] = [];
  const key = (repository: string, login: string) => `${repository}\u0000${login.toLowerCase()}`;
  const liveByKey = new Map((live.repositoryCollaborators ?? []).map((c) => [key(c.repository, c.login), c]));
  const declared = new Set<string>();

  for (const collaborator of desired.collaborators) {
    const k = key(collaborator.repository, collaborator.login);
    declared.add(k);
    const current = liveByKey.get(k);
    if (current && comparableRoleName(current.permission) === comparableRoleName(collaborator.permission)) {
      continue;
    }
    changes.push({ kind: 'set-collaborator', collaborator, current });
  }

  for (const current of live.repositoryCollaborators ?? []) {
    if (!declared.has(key(current.repository, current.login))) {
      changes.push({ kind: 'remove-collaborator', live: current });
    }
  }
  return changes;
}
