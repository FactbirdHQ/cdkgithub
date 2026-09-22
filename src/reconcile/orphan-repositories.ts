/**
 * Repositories the organization has that the definition does not account for.
 *
 * Deliberately not a change, and reported by `diff` rather than planned by
 * `apply`. An undeclared repository is not drift to correct: it is one nobody
 * has written down, and the answer is to declare it or archive it, never to have
 * a tool decide.
 *
 * It is worth reporting because the failure is silent. A repository no team
 * grants is a repository nobody is recorded as maintaining, and nothing
 * surfaces that until someone goes looking — which is exactly what `diff` is
 * for.
 */

import type { LiveRepository } from '../github/client.ts';

export interface OrphanRepository {
  readonly name: string;
  /**
   * No team reaches it at all, which is the quieter half of the problem: the
   * repository is not just undeclared, it is unreachable except by organization
   * owners and whatever roles reach everything.
   */
  readonly unreachable: boolean;
}

/**
 * @param live every repository the organization has
 * @param declared repository names the definition declares, if it declares any
 * @param granted repository names some team reaches
 */
export function orphanRepositories(
  live: readonly LiveRepository[] | undefined,
  declared: Iterable<string> | undefined,
  granted: Iterable<string>,
): OrphanRepository[] {
  if (!live) return [];

  // GitHub treats `Netcore` and `netcore` as one repository, so the comparison does.
  const lower = (names: Iterable<string>) =>
    new Set([...names].map((n) => n.toLowerCase()));

  // A definition that declares no repositories still grants them, and an
  // undeclared repository is only orphaned against a definition that claims to
  // list them. Without that claim, the grants are the whole of what is known.
  const known = declared ? lower(declared) : new Set<string>();
  const reachable = lower(granted);

  return live
    .filter((repository) => {
      const name = repository.name.toLowerCase();
      return !known.has(name) && !reachable.has(name);
    })
    .map((repository) => ({ name: repository.name, unreachable: true }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The report `diff` prints beneath the tree. */
export function renderOrphans(
  orphans: OrphanRepository[],
  paint: { muted(text: string): string },
): string {
  if (orphans.length === 0) return '';

  const lines = [
    '',
    `${orphans.length} repositor${orphans.length === 1 ? 'y' : 'ies'} in the ` +
      'organization that no team reaches and the definition does not declare.',
    paint.muted(
      '  Each one has no maintainer written down anywhere. Declare it or archive it.',
    ),
    '',
  ];
  for (const orphan of orphans) lines.push(`  ${orphan.name}`);
  return lines.join('\n');
}
