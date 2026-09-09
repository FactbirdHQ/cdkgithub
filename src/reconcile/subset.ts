/**
 * Subset comparison — the shape of diffing GitHub's governance APIs.
 *
 * Reading any of these resources back returns every field GitHub knows about,
 * including the ones the definition never mentioned and the defaults it filled
 * in. Deep equality against a partial declaration would therefore report a
 * change on every run. So the question the planner asks is not "are these
 * equal" but "does the live resource already say everything the definition
 * asks for".
 *
 * Arrays are matched without regard to order, because nothing GitHub returns
 * here is order-sensitive: a ruleset's rules, a ruleset's bypass actors, a
 * status-check list, an allowlist of action patterns. Each declared element has
 * to find its own live counterpart, and the lengths have to agree, so an extra
 * live rule still counts as a difference.
 */

/** Whether `live` already satisfies everything `desired` declares. */
export function matchesSubset(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired)) {
    return Array.isArray(live) && matchesArray(desired, live);
  }
  if (isPlainObject(desired)) {
    if (!isPlainObject(live)) return false;
    return Object.entries(desired).every(
      ([key, value]) => value === undefined || matchesSubset(value, live[key]),
    );
  }
  // Treat an absent value and an explicit null as the same thing: GitHub returns
  // null for "no description", and definitions tend to just omit the field.
  if (desired === null || desired === undefined) {
    return live === null || live === undefined;
  }
  return Object.is(desired, live);
}

/**
 * Pair every declared element with a distinct live element. Greedy is enough
 * here: the elements are distinguishable (a rule by its `type`, a bypass actor
 * by its id, a status check by its context), so no element has a choice of
 * partners that a later one needs.
 */
function matchesArray(desired: unknown[], live: unknown[]): boolean {
  if (desired.length !== live.length) return false;
  const taken = new Set<number>();
  for (const item of desired) {
    const index = live.findIndex(
      (candidate, i) => !taken.has(i) && matchesSubset(item, candidate),
    );
    if (index === -1) return false;
    taken.add(index);
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
