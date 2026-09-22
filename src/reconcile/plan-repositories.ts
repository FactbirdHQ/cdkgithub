/**
 * Decide which declared repositories GitHub does not have yet.
 *
 * There is nothing else to decide. An existing repository is adopted as it
 * stands: its settings are never read, compared or written, so declaring the
 * whole estate proposes no changes to any of it. And a declaration removed from
 * the definition removes the declaration, never the repository.
 *
 * That asymmetry is the point. Creating a repository by mistake is undone in
 * ten seconds; deleting one is not undone at all, and the edit that drops a
 * repository from a definition looks exactly like the edit that drops it from
 * the company.
 */

import type { RepositoryManifest } from '../synth/manifest.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';

export function planRepositories(
  desired: RepositoryManifest[] | undefined,
  live: LiveState,
): Change[] {
  if (!desired) return [];

  // Matched case-insensitively: GitHub treats `Netcore` and `netcore` as the same
  // repository and would answer a create for the second with a 422.
  const existing = new Set(
    (live.repositories ?? []).map((r) => r.name.toLowerCase()),
  );

  return desired
    .filter((repository) => !existing.has(repository.name.toLowerCase()))
    .map((repository) => ({ kind: 'create-repository', repository }));
}
