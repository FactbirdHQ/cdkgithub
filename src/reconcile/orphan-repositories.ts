/**
 * Repositories the definition does not account for.
 *
 * Deliberately not a change, and reported by `diff` rather than planned by
 * `apply`. Declaring a repository or archiving it is a decision about what the
 * company still does, and neither is a decision a tool should make.
 *
 * Two shapes, and the second is the quieter one. A repository nothing mentions
 * is invisible; a repository that is declared but that no team reaches is
 * visible, adopted and kept, and still open to nobody but the organization
 * owners. Declaring the estate fixes the first and says nothing about the
 * second, so both are worth naming.
 */

import type { LiveRepository } from '../github/client.ts';

export interface OrphanRepository {
  readonly name: string;
  /**
   * `undeclared`: nothing in the definition mentions it at all.
   * `unreachable`: declared, so it is adopted and kept, but no team reaches it.
   */
  readonly reason: 'undeclared' | 'unreachable';
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

  const known = declared ? lower(declared) : new Set<string>();
  const reachable = lower(granted);

  return live
    .filter((repository) => !reachable.has(repository.name.toLowerCase()))
    .map((repository) => ({
      name: repository.name,
      reason: known.has(repository.name.toLowerCase())
        ? ('unreachable' as const)
        : ('undeclared' as const),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The report `diff` prints beneath the tree. */
export function renderOrphans(
  orphans: OrphanRepository[],
  paint: { muted(text: string): string },
): string {
  if (orphans.length === 0) return '';

  const undeclared = orphans.filter((o) => o.reason === 'undeclared');
  const unreachable = orphans.filter((o) => o.reason === 'unreachable');
  const lines: string[] = [];

  const plural = (n: number) => (n === 1 ? 'y' : 'ies');

  if (undeclared.length > 0) {
    lines.push(
      '',
      `${undeclared.length} repositor${plural(undeclared.length)} the definition does not mention at all.`,
      paint.muted('  Declare it or archive it.'),
      '',
      ...undeclared.map((o) => `  ${o.name}`),
    );
  }

  if (unreachable.length > 0) {
    lines.push(
      '',
      `${unreachable.length} declared repositor${plural(unreachable.length)} that no team reaches.`,
      paint.muted(
        '  Adopted and kept, but open to nobody except the organization owners.',
      ),
      '',
      ...unreachable.map((o) => `  ${o.name}`),
    );
  }

  return lines.join('\n');
}
