/**
 * Compare two organization trees node for node.
 *
 * The result is itself a tree, so the output reads as the organization rather
 * than as a list of resources. A team that exists on both sides sits under the
 * parent the definition gives it; a team only GitHub has keeps its live parent.
 * A team that moved therefore appears once, under where it is headed, with the
 * move reported as a property change.
 *
 * A declaration carrying `previousSlug` pairs with the live team of that name,
 * so a rename is one changed team rather than an addition beside a removal.
 */

import type { RepoPermission, RepositoryAccess } from '../synth/manifest.ts';
import type { TeamRole } from './changes.ts';
import { rankOf } from './permission-rank.ts';
import { organizationRoleFloor, selfAndAncestors, teamRoleHolds } from './settled-access.ts';
import type { OrgTree, TeamNode } from './tree.ts';

export type ChangeMark = 'unchanged' | 'changed' | 'added' | 'removed';

/** A scalar team property that differs between the two sides. */
export interface PropertyChange {
  readonly property: 'slug' | 'name' | 'description' | 'privacy' | 'parent';
  readonly from: string | null;
  readonly to: string | null;
}

/** One repository whose effective access differs. */
export interface GrantChange {
  readonly repository: string;
  readonly from?: RepoPermission;
  readonly to?: RepoPermission;
}

/** Who joined or left one of a team's two rosters. */
export interface RosterChange {
  readonly role: 'maintainer' | 'member';
  readonly added: string[];
  readonly removed: string[];
}

export interface TeamDiff {
  readonly slug: string;
  readonly mark: ChangeMark;
  /** The desired node, or the live one for a team the definition does not have. */
  readonly node: TeamNode;
  /** Present whenever the team exists on both sides. */
  readonly live?: TeamNode;
  readonly properties: PropertyChange[];
  readonly grants: GrantChange[];
  readonly rosters: RosterChange[];
  /** Set when the roster was not compared because Entra owns it. */
  readonly rosterOwnedByIdp: boolean;
  readonly children: TeamDiff[];
}

export interface OrgDiff {
  readonly owner: string;
  readonly roots: TeamDiff[];
  readonly counts: { added: number; removed: number; changed: number };
}

/** Diff a live tree against a desired one. */
export function diffTrees(live: OrgTree, desired: OrgTree): OrgDiff {
  // A declaration claims the live team of its own slug, or the one it renames.
  const claimed = new Map<string, TeamNode>();
  for (const node of desired.bySlug.values()) {
    const current = live.bySlug.get(node.slug) ?? (node.previousSlug ? live.bySlug.get(node.previousSlug) : undefined);
    if (current) {
      claimed.set(node.slug, current);
    }
  }
  const spokenFor = new Set([...claimed.values()].map((n) => n.slug));
  const owners = new Set(live.owners ?? []);

  // Teams GitHub has that no declaration claims keep their live position, so
  // they are grafted into the desired shape before the walk.
  const orphansOf = new Map<string | null, TeamNode[]>();
  for (const node of live.bySlug.values()) {
    if (spokenFor.has(node.slug)) {
      continue;
    }
    const parent = node.parentSlug && desired.bySlug.has(node.parentSlug) ? node.parentSlug : null;
    const bucket = orphansOf.get(parent) ?? [];
    bucket.push(node);
    orphansOf.set(parent, bucket);
  }

  const removedSubtree = (node: TeamNode): TeamDiff => ({
    slug: node.slug,
    mark: 'removed',
    node,
    properties: [],
    grants: [],
    rosters: [],
    rosterOwnedByIdp: false,
    children: node.children.filter((c) => !spokenFor.has(c.slug)).map(removedSubtree),
  });

  const orphansUnder = (slug: string | null): TeamDiff[] =>
    (orphansOf.get(slug) ?? []).sort((a, b) => a.slug.localeCompare(b.slug)).map(removedSubtree);

  const walk = (node: TeamNode): TeamDiff => {
    const current = claimed.get(node.slug);
    const children = [...node.children.map(walk), ...orphansUnder(node.slug)].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );

    if (!current) {
      return {
        slug: node.slug,
        mark: 'added',
        node,
        properties: [],
        grants: [],
        rosters: [],
        rosterOwnedByIdp: false,
        children,
      };
    }

    const properties = diffProperties(current, node);
    const floor = organizationRoleFloor(
      selfAndAncestors(current.slug, (slug) => live.bySlug.get(slug)?.parentSlug),
      live.orgRoles ?? [],
      live.ranks,
    );
    const grants = diffGrants(current.effectiveRepositories, node.effectiveRepositories, floor, live.ranks);
    // Entra drives an IdP-synced roster, so comparing it here would report the
    // next SCIM push as drift the definition is supposed to fix.
    const rosters =
      node.idpSynced || !node.declaresRoster ? [] : diffRosters(current, node, owners, heldBelow(node, claimed));

    const touched = properties.length > 0 || grants.length > 0 || rosters.length > 0;

    return {
      slug: node.slug,
      mark: touched ? 'changed' : 'unchanged',
      node,
      live: current,
      properties,
      grants,
      rosters,
      rosterOwnedByIdp: node.idpSynced,
      children,
    };
  };

  const roots = [...desired.roots.map(walk), ...orphansUnder(null)].sort((a, b) => a.slug.localeCompare(b.slug));

  return { owner: desired.owner, roots, counts: countMarks(roots) };
}

function diffProperties(live: TeamNode, desired: TeamNode): PropertyChange[] {
  const changes: PropertyChange[] = [];
  const compare = (property: PropertyChange['property'], from: string | null, to: string | null) => {
    if (from !== to) {
      changes.push({ property, from, to });
    }
  };

  // Reported first, because a differing slug is the rename that paired these two
  // and every other change below it belongs to one team rather than two.
  compare('slug', live.slug, desired.slug);
  compare('name', live.name, desired.name);
  compare('description', live.description, desired.description);
  compare('privacy', live.privacy, desired.privacy);
  compare('parent', live.parentSlug, desired.parentSlug);
  return changes;
}

/**
 * GitHub reports an organization role's base permission as a grant on every
 * repository the team lists. Two sides that both sit at or below that floor
 * hold the same access, whichever role names they carry.
 */
function diffGrants(
  live: RepositoryAccess,
  desired: RepositoryAccess,
  floor: string | undefined,
  ranks: Map<string, number>,
): GrantChange[] {
  const repositories = [...new Set([...Object.keys(live), ...Object.keys(desired)])].sort();
  const withinFloor = (permission: RepoPermission | undefined) =>
    floor !== undefined && (permission === undefined || rankOf(permission, ranks) <= rankOf(floor, ranks));

  return repositories
    .filter((repo) => live[repo] !== desired[repo])
    .filter((repo) => !(withinFloor(live[repo]) && withinFloor(desired[repo])))
    .map((repo) => ({ repository: repo, from: live[repo], to: desired[repo] }));
}

function heldBelow(node: TeamNode, claimed: ReadonlyMap<string, TeamNode>): Set<string> {
  const held = new Set<string>();
  const walk = (child: TeamNode) => {
    const logins =
      child.declaresRoster && !child.idpSynced
        ? [...child.maintainers, ...child.members]
        : [...(claimed.get(child.slug)?.reportedRoles?.keys() ?? [])];
    for (const login of logins) {
      held.add(login);
    }
    child.children.forEach(walk);
  };
  node.children.forEach(walk);
  return held;
}

/**
 * A declared person needs no change when their reported role holds and the
 * team holds them directly or through a team below that keeps them, as in
 * `plan`.
 */
function diffRosters(
  live: TeamNode,
  desired: TeamNode,
  owners: ReadonlySet<string>,
  heldAfter: ReadonlySet<string>,
): RosterChange[] {
  const declared = new Map<string, TeamRole>([
    ...desired.members.map((login) => [login, 'member'] as const),
    ...desired.maintainers.map((login) => [login, 'maintainer'] as const),
  ]);
  const direct = new Map<string, TeamRole>([
    ...live.members.map((login) => [login, 'member'] as const),
    ...live.maintainers.map((login) => [login, 'maintainer'] as const),
  ]);

  const added: Record<TeamRole, string[]> = { maintainer: [], member: [] };
  const removed: Record<TeamRole, string[]> = { maintainer: [], member: [] };
  for (const [login, role] of declared) {
    const held = direct.has(login) || heldAfter.has(login);
    if (held && teamRoleHolds(live.reportedRoles?.get(login), role, owners.has(login))) {
      continue;
    }
    added[role].push(login);
    const was = direct.get(login);
    if (was !== undefined && was !== role) {
      removed[was].push(login);
    }
  }
  for (const [login, role] of direct) {
    if (!declared.has(login)) {
      removed[role].push(login);
    }
  }

  return (['maintainer', 'member'] as const)
    .map((role) => ({ role, added: added[role].sort(), removed: removed[role].sort() }))
    .filter((r) => r.added.length > 0 || r.removed.length > 0);
}

function countMarks(roots: TeamDiff[]): OrgDiff['counts'] {
  const counts = { added: 0, removed: 0, changed: 0 };
  const walk = (diff: TeamDiff) => {
    if (diff.mark === 'added') {
      counts.added++;
    } else if (diff.mark === 'removed') {
      counts.removed++;
    } else if (diff.mark === 'changed') {
      counts.changed++;
    }
    for (const child of diff.children) {
      walk(child);
    }
  };
  for (const root of roots) {
    walk(root);
  }
  return counts;
}
