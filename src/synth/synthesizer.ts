import type { IConstruct } from 'constructs';
import { Organization } from '../constructs/organization.ts';
import { Team } from '../constructs/team.ts';
import type {
  DesiredState,
  ExternalGroupBinding,
  TeamManifest,
} from './manifest.ts';

/**
 * Walk a construct tree and produce the desired-state manifest for the single
 * organization it defines.
 *
 * Rules:
 * - Exactly one `Organization` must exist in the tree.
 * - A `Team` nested (at any depth) under another `Team` is a child of the
 *   nearest ancestor `Team` (`parent_team_id`).
 * - Teams are emitted parents-before-children so `apply` can create parents first.
 */
export function synthesize(root: IConstruct): DesiredState {
  const orgs = root.node.findAll().filter(isOrganization);
  if (orgs.length === 0) {
    throw new Error(
      'No Organization found in the construct tree. Define one with `new Organization(app, id, { login })`.',
    );
  }
  if (orgs.length > 1) {
    throw new Error(
      `Expected exactly one Organization, found ${orgs.length}: ${orgs
        .map((o) => o.login)
        .join(', ')}. Synthesize one organization per app.`,
    );
  }
  const org = orgs[0]!;

  const teams = root.node
    .findAll()
    .filter(isTeam)
    .map((team) => toManifest(team));

  // Ensure a team's parent appears before it, so consumers can create in order.
  teams.sort((a, b) => depthOf(a, teams) - depthOf(b, teams));

  assertUniqueSlugs(teams);

  return { org: org.login, teams };
}

function toManifest(team: Team): TeamManifest {
  const parent = nearestTeamAncestor(team);
  const externalGroup = normalizeExternalGroup(team);

  return {
    slug: team.slug,
    name: team.teamName,
    description: team.props.description,
    privacy: team.props.privacy ?? 'closed',
    parentSlug: parent?.slug,
    maintainers: team.props.maintainers ?? [],
    members: team.props.members ?? [],
    repositories: team.props.repositories ?? {},
    externalGroup,
  };
}

function normalizeExternalGroup(team: Team): ExternalGroupBinding | undefined {
  const eg = team.props.externalGroup;
  if (!eg) return undefined;
  if (eg.id === undefined && eg.name === undefined) {
    throw new Error(
      `Team "${team.teamName}" has an externalGroup with neither a name nor an id.`,
    );
  }
  return { name: eg.name, id: eg.id };
}

/** The nearest ancestor that is a Team, or undefined for a top-level team. */
function nearestTeamAncestor(team: Team): Team | undefined {
  let scope = team.node.scope;
  while (scope) {
    if (isTeam(scope)) return scope;
    scope = scope.node.scope;
  }
  return undefined;
}

/** Chain length from a team up to a top-level team (0 = top level). */
function depthOf(team: TeamManifest, all: TeamManifest[]): number {
  let depth = 0;
  let current: TeamManifest | undefined = team;
  const bySlug = new Map(all.map((t) => [t.slug, t] as const));
  while (current?.parentSlug) {
    depth++;
    current = bySlug.get(current.parentSlug);
    if (depth > all.length) break; // cycle guard
  }
  return depth;
}

function assertUniqueSlugs(teams: TeamManifest[]): void {
  const seen = new Set<string>();
  for (const team of teams) {
    if (seen.has(team.slug)) {
      throw new Error(
        `Duplicate team slug "${team.slug}". Team names must slugify uniquely.`,
      );
    }
    seen.add(team.slug);
  }
}

function isOrganization(c: IConstruct): c is Organization {
  return c instanceof Organization;
}

function isTeam(c: IConstruct): c is Team {
  return c instanceof Team;
}
