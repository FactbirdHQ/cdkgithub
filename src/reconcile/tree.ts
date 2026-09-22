/**
 * The organization as a tree of teams, built the same way from either side.
 *
 * `plan` compares resource by resource because it drives `apply`, and reads only
 * the surfaces a team declares. `diff` asks what the org looks like next to what
 * the definition says, which is a question about shape, so it reads every team
 * whole and renders both sides into the structure below.
 *
 * Two GitHub behaviours have to be undone before the sides are comparable. A
 * team's member list arrives carrying everyone in a descendant team, and its
 * repository list arrives carrying every grant an ancestor makes. The definition
 * declares neither, so the live read is narrowed to direct members, and both
 * sides then resolve the same effective repository access.
 */

import type {
  GitHubClient,
  LiveCustomRepositoryRole,
  LiveRepository,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
} from '../github/client.ts';
import { comparableRoleName } from '../github/client.ts';
import type {
  DesiredState,
  RepoPermission,
  RepositoryAccess,
  TeamPrivacy,
} from '../synth/manifest.ts';
import { assignmentFromLive } from './org-role-access.ts';
import type { OrgRoleAssignment } from './org-role-access.ts';
import {
  rankCustomRoles,
  rankOf,
  strongerPermission,
} from './permission-rank.ts';

/** One team, with its roster narrowed and its repository access resolved. */
export interface TeamNode {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly privacy: TeamPrivacy;
  readonly parentSlug: string | null;
  /** The live team this declaration renames, when it renames one. */
  readonly previousSlug?: string;
  /** Maintainers of this team. GitHub does not inherit the maintainer role. */
  readonly maintainers: string[];
  /** Members of this team alone, with every descendant's roster subtracted. */
  readonly members: string[];
  /** What the team holds in its own right. */
  readonly repositories: RepositoryAccess;
  /** Own grants unioned with every ancestor's, each at the stronger permission. */
  readonly effectiveRepositories: RepositoryAccess;
  /** Entra owns the roster when the team is IdP-synced, so the diff says so. */
  readonly idpSynced: boolean;
  readonly children: TeamNode[];
}

/** One side of the comparison. */
export interface OrgTree {
  readonly owner: string;
  readonly roots: TeamNode[];
  /** Every node keyed by slug, for the diff to pair the two sides up. */
  readonly bySlug: ReadonlyMap<string, TeamNode>;
  /** Permission order, which custom repository roles take part in. */
  readonly ranks: Map<string, number>;
  /** The roles behind that order, to rank the other side the same way. */
  readonly customRoles: readonly LiveCustomRepositoryRole[];
  /** Every repository the organization has, for the orphan report. */
  readonly repositories?: readonly LiveRepository[];
  /**
   * Organization roles and who holds them.
   *
   * Outside the team tree and wider than any of it: a role carrying a
   * `base_role` is a permission on every repository at once. The access review
   * folds it back in, which is the only place the two meet.
   */
  readonly orgRoles?: readonly OrgRoleAssignment[];
}

/** The fields a team carries before its place in the tree is known. */
interface TeamSeed {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly privacy: TeamPrivacy;
  readonly parentSlug: string | null;
  readonly previousSlug?: string;
  readonly maintainers: string[];
  readonly members: string[];
  readonly repositories: RepositoryAccess;
  readonly idpSynced: boolean;
}

/**
 * Read the whole live organization and render it as a tree.
 *
 * Two calls per team, issued together with every other team's. The org is tens
 * of teams, so the request count is bounded by the team count rather than paced
 * through a pool. This is also why `diff` is its own command: `plan` reads only
 * what a definition declares, and reading everything costs more than a plan
 * should.
 */
export async function readLiveTree(
  client: GitHubClient,
  owner: string,
  ownerType: DesiredState['ownerType'] = 'organization',
): Promise<OrgTree> {
  // A personal account has no teams, and asking for them 404s.
  if (ownerType === 'user') return buildTree(owner, [], []);

  const [teams, customRoles, repositories, orgRoles] = await Promise.all([
    client.listTeams(owner),
    readCustomRoles(client, owner),
    client.listRepositories(owner),
    readOrgRoles(client, owner),
  ]);
  const ranks = rankCustomRoles(customRoles);

  const seeds = await Promise.all(
    teams.map(async (team) => {
      const [roster, repos] = await Promise.all([
        client.listTeamMembers(owner, team.slug),
        client.listTeamRepositories(owner, team.slug),
      ]);
      return seedFromLive(team, roster, repos);
    }),
  );

  return {
    ...buildTree(owner, narrowLiveSeeds(seeds, ranks), customRoles),
    repositories,
    orgRoles,
  };
}

/**
 * Organization roles and who holds them, or none when the token cannot see them.
 *
 * Read for the same reason the custom repository roles are: a role carrying a
 * base permission reaches every repository, so an access review without it
 * describes a smaller organization than the real one. Not worth failing the
 * whole diff over, though.
 */
async function readOrgRoles(
  client: GitHubClient,
  owner: string,
): Promise<OrgRoleAssignment[]> {
  try {
    const roles = await client.listOrganizationRoles(owner);
    return await Promise.all(
      roles.map(async (role) =>
        assignmentFromLive({
          ...role,
          ...(await client.readRoleAssignment(owner, role.id)),
        }),
      ),
    );
  } catch {
    return [];
  }
}

/**
 * The org's custom repository roles, or none when the token cannot see them.
 *
 * A grant made through one shows up on the team under the role's display name,
 * so without the roles it ranks below `pull` and every child re-declaring it
 * reads as drift. Reading them is not worth failing the whole diff over,
 * though: a token that cannot see them still gets a tree.
 */
async function readCustomRoles(
  client: GitHubClient,
  owner: string,
): Promise<LiveCustomRepositoryRole[]> {
  try {
    return await client.listCustomRepositoryRoles(owner);
  } catch {
    return [];
  }
}

function seedFromLive(
  team: LiveTeam,
  roster: LiveTeamMember[],
  repos: LiveTeamRepository[],
): TeamSeed {
  const repositories: RepositoryAccess = {};
  for (const repo of repos) {
    repositories[repo.name] = comparableRoleName(repo.roleName);
  }

  const logins = (role: LiveTeamMember['role']) =>
    roster
      .filter((m) => m.role === role)
      .map((m) => m.login)
      .sort();

  return {
    slug: team.slug,
    name: team.name,
    description: team.description ?? '',
    privacy: team.privacy,
    parentSlug: team.parentSlug,
    maintainers: logins('maintainer'),
    members: logins('member'),
    repositories,
    idpSynced: false,
  };
}

/**
 * Render a synthesized manifest as the same tree.
 *
 * `customRoles` ranks a grant made through a custom repository role. Passing
 * none leaves such a grant unranked, which is right for a definition read on its
 * own and wrong for one about to be compared, so `diff` passes the live roles.
 */
export function desiredTree(
  desired: DesiredState,
  customRoles: readonly LiveCustomRepositoryRole[] = [],
  liveOrgRoles: readonly OrgRoleAssignment[] = [],
  repositories: readonly LiveRepository[] = [],
): OrgTree {
  const seeds = desired.teams.map(
    (t) =>
      ({
        slug: t.slug,
        name: t.name,
        description: t.description ?? '',
        privacy: t.privacy,
        parentSlug: t.parentSlug ?? null,
        previousSlug: t.previousSlug,
        // A manifest is read off disk, so an older one may predate a field.
        maintainers: [...(t.maintainers ?? [])].sort(),
        members: [...(t.members ?? [])].sort(),
        repositories: t.repositories ?? {},
        idpSynced: t.externalGroup !== undefined,
      }) satisfies TeamSeed,
  );
  // What a role grants is GitHubs, not the definitions: the manifest says who
  // holds one, and the live role says what holding it reaches.
  const reachOf = new Map(liveOrgRoles.map((r) => [r.name, r.baseRole]));
  const orgRoles = (desired.organizationRoles ?? []).map((r) => ({
    name: r.name,
    teams: r.teams ?? [],
    users: r.users ?? [],
    baseRole: reachOf.get(r.name),
  }));

  return {
    ...buildTree(desired.owner, seeds, customRoles),
    orgRoles,
    repositories,
  };
}

/**
 * Subtract inherited entries from a live read.
 *
 * GitHub reports a descendant team's members as members of every team above it,
 * and an ancestor team's grants as grants of every team below it. A definition
 * declares neither, so both are removed here; the grants come back as
 * `effectiveRepositories` once the tree is assembled.
 */
function narrowLiveSeeds(
  seeds: TeamSeed[],
  ranks: Map<string, number>,
): TeamSeed[] {
  const bySlug = new Map(seeds.map((s) => [s.slug, s] as const));

  const ancestors = (slug: string): TeamSeed[] => {
    const out: TeamSeed[] = [];
    const seen = new Set<string>([slug]);
    let current = bySlug.get(slug)?.parentSlug ?? null;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = bySlug.get(current);
      if (!parent) break;
      out.push(parent);
      current = parent.parentSlug;
    }
    return out;
  };

  const ancestorsOf = new Map(seeds.map((s) => [s.slug, ancestors(s.slug)]));

  return seeds.map((seed) => {
    const inheritedMembers = new Set<string>();
    for (const other of seeds) {
      const above = ancestorsOf.get(other.slug) ?? [];
      if (!above.some((a) => a.slug === seed.slug)) continue;
      for (const m of other.members) inheritedMembers.add(m);
      for (const m of other.maintainers) inheritedMembers.add(m);
    }

    // A grant is the team's own when no ancestor makes it at the same strength
    // or better. An ancestor holding `pull` where the child shows `admin` means
    // the child was granted `admin` in its own right.
    const above = ancestorsOf.get(seed.slug) ?? [];
    const own: RepositoryAccess = {};
    for (const [repo, permission] of Object.entries(seed.repositories)) {
      const strongest = above
        .map((a) => a.repositories[repo])
        .filter((p): p is RepoPermission => p !== undefined)
        .reduce<RepoPermission | undefined>(
          (acc, p) => (acc ? strongerPermission(acc, p, ranks) : p),
          undefined,
        );
      if (
        strongest === undefined ||
        rankOf(strongest, ranks) < rankOf(permission, ranks)
      ) {
        own[repo] = permission;
      }
    }

    return {
      ...seed,
      members: seed.members.filter((m) => !inheritedMembers.has(m)),
      repositories: own,
    };
  });
}

/** Assemble seeds into a tree, resolving effective repository access on the way. */
function buildTree(
  owner: string,
  seeds: TeamSeed[],
  customRoles: readonly LiveCustomRepositoryRole[],
): OrgTree {
  const ranks = rankCustomRoles(customRoles);
  const bySlug = new Map<string, TeamNode>();
  const seedBySlug = new Map(seeds.map((s) => [s.slug, s] as const));
  const childrenOf = new Map<string | null, TeamSeed[]>();
  for (const seed of seeds) {
    // A team whose declared parent is missing from this side is treated as
    // top-level, so an unreadable parent never hides a subtree from the diff.
    const parent =
      seed.parentSlug && seedBySlug.has(seed.parentSlug)
        ? seed.parentSlug
        : null;
    const bucket = childrenOf.get(parent) ?? [];
    bucket.push(seed);
    childrenOf.set(parent, bucket);
  }

  const build = (seed: TeamSeed, inherited: RepositoryAccess): TeamNode => {
    const effective: RepositoryAccess = { ...inherited };
    for (const [repo, permission] of Object.entries(seed.repositories)) {
      const existing = effective[repo];
      effective[repo] = existing
        ? strongerPermission(existing, permission, ranks)
        : permission;
    }

    const node: TeamNode = {
      slug: seed.slug,
      name: seed.name,
      description: seed.description,
      privacy: seed.privacy,
      parentSlug: seed.parentSlug,
      previousSlug: seed.previousSlug,
      maintainers: seed.maintainers,
      members: seed.members,
      repositories: seed.repositories,
      effectiveRepositories: effective,
      idpSynced: seed.idpSynced,
      children: (childrenOf.get(seed.slug) ?? [])
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((child) => build(child, effective)),
    };
    bySlug.set(node.slug, node);
    return node;
  };

  const roots = (childrenOf.get(null) ?? [])
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((seed) => build(seed, {}));

  return { owner, roots, bySlug, ranks, customRoles };
}

/**
 * Grants a team declares that an ancestor already makes at the same strength or
 * better, so removing them would change nothing.
 *
 * FactbirdHQ's definition carries hundreds of these, left over from the import
 * that generated it. They are reported alongside the diff rather than inside it
 * because they are not drift: both sides agree, and the cleanup is a separate
 * edit to the definition.
 */
export function redundantGrants(
  tree: OrgTree,
): Array<{ slug: string; repositories: string[] }> {
  const out: Array<{ slug: string; repositories: string[] }> = [];

  const walk = (node: TeamNode, inherited: RepositoryAccess): void => {
    const redundant = Object.entries(node.repositories)
      .filter(([repo, permission]) => {
        const from = inherited[repo];
        return (
          from !== undefined &&
          rankOf(from, tree.ranks) >= rankOf(permission, tree.ranks)
        );
      })
      .map(([repo]) => repo)
      .sort();

    if (redundant.length > 0) {
      out.push({ slug: node.slug, repositories: redundant });
    }
    for (const child of node.children) walk(child, node.effectiveRepositories);
  };

  for (const root of tree.roots) walk(root, {});
  return out;
}
