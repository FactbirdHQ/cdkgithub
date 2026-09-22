/**
 * The tree, pivoted onto the people in it.
 *
 * A team-shaped diff answers what changes; an access review asks who can reach
 * what, which is the same data read down the other axis. Both are built from the
 * same two trees, so the two views cannot disagree.
 *
 * Someone's access is the union of the effective access of every team they
 * belong to directly. Belonging to a parent team does not confer a child's
 * grants, only the other way around, and {@link TeamNode.effectiveRepositories}
 * has already resolved that direction. Being reported on a parent because of a
 * child team is not membership of the parent, and the live read has already
 * subtracted it.
 *
 * Two things this cannot see, both outside the team structure: an organization
 * owner reaches every repository whatever the teams say, and a collaborator
 * added to one repository by hand holds a grant no team records.
 */

import { comparableRoleName } from '../github/client.ts';
import type { RepoPermission, RepositoryAccess } from '../synth/manifest.ts';
import { holdersOf } from './org-role-access.ts';
import { rankOf, strongerPermission } from './permission-rank.ts';
import type { OrgTree, TeamNode } from './tree.ts';

/** How one person reaches one repository. */
export interface RepositoryReach {
  readonly repository: string;
  readonly permission: RepoPermission;
  /**
   * The teams whose own declaration grants it, strongest first.
   *
   * Not the team the person belongs to. A child inherits what its ancestors
   * grant, so most of what someone in a leaf team reaches is written further
   * up; naming the leaf would say where they joined rather than where the
   * access comes from, and send anyone trying to change it to a file that does
   * not mention the repository.
   */
  readonly through: string[];
  /**
   * The organization role supplying this permission, when one does.
   *
   * Such a role reaches every repository at once, so a report that lists it
   * per repository says the same sentence two hundred times. The tag is what
   * lets the renderer say it once and list only what exceeds it.
   */
  readonly blanket?: string;
}

/** Everything one person can reach, on one side of the comparison. */
export interface PersonAccess {
  readonly login: string;
  /** Teams they belong to directly, by slug. */
  readonly teams: string[];
  readonly repositories: Map<string, RepositoryReach>;
}

/** One repository whose reach differs between the two sides. */
export interface ReachChange {
  readonly repository: string;
  readonly from?: RepositoryReach;
  readonly to?: RepositoryReach;
}

/** One person, before and after. */
export interface PersonDiff {
  readonly login: string;
  readonly before: PersonAccess;
  readonly after: PersonAccess;
  readonly gained: ReachChange[];
  readonly lost: ReachChange[];
  readonly changed: ReachChange[];
  readonly teamsJoined: string[];
  readonly teamsLeft: string[];
  /** True when nothing about this person's reach differs. */
  readonly unchanged: boolean;
}

/** Pivot one tree onto its people. */
export function accessByPerson(tree: OrgTree): Map<string, PersonAccess> {
  interface Accumulator {
    teams: string[];
    reach: Map<string, RepositoryReach>;
  }
  const people = new Map<string, Accumulator>();

  const record = (login: string, team: TeamNode) => {
    const entry: Accumulator = people.get(login) ?? {
      teams: [],
      reach: new Map(),
    };
    entry.teams.push(team.slug);

    for (const [repository, permission] of Object.entries(
      team.effectiveRepositories,
    )) {
      const source = declaringTeam(team, repository, tree);
      const held = entry.reach.get(repository);
      if (!held) {
        entry.reach.set(repository, {
          repository,
          permission,
          through: [source],
        });
        continue;
      }
      const strongest = strongerPermission(
        held.permission,
        permission,
        tree.ranks,
      );
      entry.reach.set(repository, {
        repository,
        permission: strongest,
        through: [...held.through, source],
      });
    }
    people.set(login, entry);
  };

  const walk = (team: TeamNode) => {
    for (const login of team.maintainers) record(login, team);
    for (const login of team.members) record(login, team);
    for (const child of team.children) walk(child);
  };
  for (const root of tree.roots) walk(root);

  // Organization roles, folded in last.
  //
  // A role carrying a base permission reaches every repository the
  // organization has, so it is applied over the whole estate rather than a
  // list, and only where it beats what the teams already gave. Someone holding
  // `all_repo_maintain` therefore shows every repository, which is the truth a
  // team-only report leaves out.
  const estate = (tree.repositories ?? []).map((r) => r.name);
  for (const role of tree.orgRoles ?? []) {
    if (!role.baseRole || estate.length === 0) continue;
    const permission = comparableRoleName(role.baseRole) as RepoPermission;
    const holders = holdersOf(role, (slug) => membersBelow(slug, tree));
    for (const login of holders) {
      const entry: Accumulator = people.get(login) ?? {
        teams: [],
        reach: new Map(),
      };
      for (const repository of estate) {
        const held = entry.reach.get(repository);
        // What is already held wins a tie, so a team granting as much as the
        // role keeps the credit, and so does the stronger of two roles. Every
        // holder is folded in this way, one role at a time, which is why the
        // tag a previous round set has to survive a round it does not win.
        const heldWins =
          held !== undefined &&
          rankOf(held.permission, tree.ranks) >= rankOf(permission, tree.ranks);
        if (heldWins) continue;

        entry.reach.set(repository, {
          repository,
          permission,
          through: [
            ...(held?.through ?? []),
            `${role.name} (organization role)`,
          ],
          blanket: role.name,
        });
      }
      people.set(login, entry);
    }
  }

  return new Map(
    [...people.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([login, entry]) => [
        login,
        {
          login,
          teams: [...entry.teams].sort(),
          // The strongest grant first, so the reason someone reaches a
          // repository reads before the teams that merely repeat it.
          repositories: new Map(
            [...entry.reach.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([repository, reach]) => [
                repository,
                {
                  ...reach,
                  through: orderByStrength(reach.through, tree),
                },
              ]),
          ),
        },
      ]),
  );
}

/**
 * The team whose own declaration produces a repository's effective permission.
 *
 * Walks from the team the person belongs to up to the root and takes the
 * strongest declaration, preferring the shallowest on a tie: that is where the
 * grant originates, and a child repeating it changes nothing.
 */
function declaringTeam(
  team: TeamNode,
  repository: string,
  tree: OrgTree,
): string {
  let source = team.slug;
  let best = -1;
  let node: TeamNode | undefined = team;
  const seen = new Set<string>();

  while (node && !seen.has(node.slug)) {
    seen.add(node.slug);
    const own = node.repositories[repository];
    if (own !== undefined) {
      const rank = rankOf(own, tree.ranks);
      // `>=` so an ancestor granting the same thing wins: it is the origin.
      if (rank >= best) {
        best = rank;
        source = node.slug;
      }
    }
    node = node.parentSlug ? tree.bySlug.get(node.parentSlug) : undefined;
  }
  return source;
}

/** The teams granting a repository, the one that decides the permission first. */
function orderByStrength(slugs: string[], tree: OrgTree): string[] {
  return [...new Set(slugs)].sort((a, b) => {
    const rank = (slug: string) => {
      const node = tree.bySlug.get(slug);
      if (!node) return 0;
      return Math.max(
        0,
        ...Object.values(node.effectiveRepositories).map((p) =>
          rankOf(p, tree.ranks),
        ),
      );
    };
    return rank(b) - rank(a) || a.localeCompare(b);
  });
}

/** Compare the two trees person by person. */
export function diffAccessByPerson(
  live: OrgTree,
  desired: OrgTree,
): PersonDiff[] {
  const before = accessByPerson(live);
  const after = accessByPerson(desired);
  const logins = [...new Set([...before.keys(), ...after.keys()])].sort(
    (a, b) => a.localeCompare(b),
  );

  const empty = (login: string): PersonAccess => ({
    login,
    teams: [],
    repositories: new Map(),
  });

  return logins.map((login) => {
    const was = before.get(login) ?? empty(login);
    const now = after.get(login) ?? empty(login);

    const gained: ReachChange[] = [];
    const lost: ReachChange[] = [];
    const changed: ReachChange[] = [];

    for (const [repository, to] of now.repositories) {
      const from = was.repositories.get(repository);
      if (!from) gained.push({ repository, to });
      else if (from.permission !== to.permission) {
        changed.push({ repository, from, to });
      }
    }
    for (const [repository, from] of was.repositories) {
      if (!now.repositories.has(repository)) lost.push({ repository, from });
    }

    const wasTeams = new Set(was.teams);
    const nowTeams = new Set(now.teams);

    return {
      login,
      before: was,
      after: now,
      gained,
      lost,
      changed,
      teamsJoined: now.teams.filter((t) => !wasTeams.has(t)),
      teamsLeft: was.teams.filter((t) => !nowTeams.has(t)),
      unchanged:
        gained.length === 0 && lost.length === 0 && changed.length === 0,
    };
  });
}

/**
 * Everyone in a team and in every team beneath it.
 *
 * An organization role assigned to a team reaches the people below it too,
 * because a child team's members are members of the parent as far as the
 * assignment is concerned.
 */
function membersBelow(slug: string, tree: OrgTree): string[] {
  const root = tree.bySlug.get(slug);
  if (!root) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: TeamNode) => {
    if (seen.has(node.slug)) return;
    seen.add(node.slug);
    out.push(...node.maintainers, ...node.members);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/** A person's repositories as a plain map, for a report that wants only that. */
export function reachAsAccess(access: PersonAccess): RepositoryAccess {
  const out: RepositoryAccess = {};
  for (const [repository, reach] of access.repositories) {
    out[repository] = reach.permission;
  }
  return out;
}
