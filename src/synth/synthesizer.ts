import type { IConstruct } from 'constructs';
import { ActionsPolicy } from '../constructs/actions-policy.ts';
import { BranchProtection } from '../constructs/branch-protection.ts';
import { CodeSecurityConfiguration } from '../constructs/code-security.ts';
import { CustomProperty } from '../constructs/custom-property.ts';
import { Organization } from '../constructs/organization.ts';
import { Repository } from '../constructs/repository.ts';
import { Ruleset } from '../constructs/ruleset.ts';
import { Team } from '../constructs/team.ts';
import { UserAccount } from '../constructs/user-account.ts';
import type { BranchProtectionManifest } from './branch-protection.ts';
import type {
  ActionsPolicyManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  RulesetManifest,
} from './governance.ts';
import type {
  DesiredState,
  ExternalGroupBinding,
  OwnerType,
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
 * - Governance constructs (rulesets, the Actions policy, code security
 *   configurations, custom properties) are collected wherever they sit in the
 *   tree. A collection is emitted only when the definition declares at least one
 *   of that kind, which is how the planner knows the surface is managed.
 */
export function synthesize(root: IConstruct): DesiredState {
  const owner = resolveOwner(root);

  const teams = root.node
    .findAll()
    .filter(isTeam)
    .map((team) => toManifest(team));

  // Ensure a team's parent appears before it, so consumers can create in order.
  teams.sort((a, b) => depthOf(a, teams) - depthOf(b, teams));

  assertUniqueSlugs(teams);

  const branchProtection = collect(root, BranchProtection, toBranchProtection);
  const rulesets = collect(root, Ruleset, toRulesetManifest);
  const codeSecurityConfigurations = collect(
    root,
    CodeSecurityConfiguration,
    toCodeSecurityManifest,
  );
  const customProperties = collect(
    root,
    CustomProperty,
    toCustomPropertyManifest,
  );

  assertUniqueNames(rulesets, 'ruleset');
  assertUniqueNames(codeSecurityConfigurations, 'code security configuration');
  assertUniqueNames(customProperties, 'custom property');

  const state: DesiredState = {
    owner: owner.login,
    ownerType: owner.type,
    teams,
    settings: owner.settings,
    actions: singleActionsPolicy(root),
    rulesets,
    codeSecurityConfigurations,
    customProperties,
    branchProtection,
  };

  if (owner.type === 'user') assertNothingOrgWide(state);

  return state;
}

interface ResolvedOwner {
  readonly login: string;
  readonly type: OwnerType;
  readonly settings?: Organization['settings'];
}

/** The single Organization or UserAccount the tree is defined against. */
function resolveOwner(root: IConstruct): ResolvedOwner {
  const owners = root.node
    .findAll()
    .filter(
      (c): c is Organization | UserAccount =>
        c instanceof Organization || c instanceof UserAccount,
    );

  if (owners.length === 0) {
    throw new Error(
      'No Organization or UserAccount found in the construct tree. Define one with `new Organization(app, id, { login })` or `new UserAccount(app, id, { login })`.',
    );
  }
  if (owners.length > 1) {
    throw new Error(
      `Expected exactly one Organization or UserAccount, found ${owners.length}: ${owners
        .map((o) => o.login)
        .join(', ')}. Synthesize one account per app.`,
    );
  }

  const owner = owners[0]!;
  return owner instanceof Organization
    ? { login: owner.login, type: 'organization', settings: owner.settings }
    : { login: owner.login, type: 'user' };
}

/**
 * A personal account has none of the org-wide surfaces, so declaring one is a
 * mistake worth failing on rather than a setting that quietly never applies.
 */
function assertNothingOrgWide(state: DesiredState): void {
  const orgOnly: Array<[string, unknown]> = [
    ['Team', state.teams.length > 0 ? state.teams : undefined],
    ['Organization settings', state.settings],
    ['ActionsPolicy', state.actions],
    ['Ruleset', state.rulesets],
    ['CodeSecurityConfiguration', state.codeSecurityConfigurations],
    ['CustomProperty', state.customProperties],
  ];

  const declared = orgOnly
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);

  if (declared.length > 0) {
    throw new Error(
      `UserAccount "${state.owner}" declares ${declared.join(', ')}, which GitHub only offers to organizations. A personal account supports repositories and their branch protection.`,
    );
  }
}

/** The repository a branch protection sits under, by nesting or by name. */
function toBranchProtection(
  protection: BranchProtection,
): BranchProtectionManifest {
  const repository =
    protection.props.repository ??
    nearestRepository(protection)?.repositoryName;

  if (!repository) {
    throw new Error(
      `BranchProtection "${protection.branch}" names no repository. Nest it under a Repository, or pass \`repository\`.`,
    );
  }

  const { repository: _ignored, branch: _branch, ...rest } = protection.props;
  return { repository, branch: protection.branch, ...rest };
}

function nearestRepository(construct: IConstruct): Repository | undefined {
  let scope = construct.node.scope;
  while (scope) {
    if (scope instanceof Repository) return scope;
    scope = scope.node.scope;
  }
  return undefined;
}

/**
 * Find every construct of one kind and map it to its manifest form, or return
 * `undefined` when the definition declares none. The distinction matters: an
 * absent collection means the surface is unmanaged, an empty one would mean the
 * definition owns the surface and wants it empty.
 */
function collect<C extends IConstruct, M>(
  root: IConstruct,
  type: abstract new (...args: never[]) => C,
  toManifest: (construct: C) => M,
): M[] | undefined {
  const found = root.node.findAll().filter((c): c is C => c instanceof type);
  return found.length > 0 ? found.map(toManifest) : undefined;
}

function singleActionsPolicy(
  root: IConstruct,
): ActionsPolicyManifest | undefined {
  const policies = root.node
    .findAll()
    .filter((c): c is ActionsPolicy => c instanceof ActionsPolicy);
  if (policies.length > 1) {
    throw new Error(
      `Expected at most one ActionsPolicy, found ${policies.length}. The Actions policy is a single org-wide resource.`,
    );
  }
  return policies[0]?.props;
}

function toRulesetManifest(ruleset: Ruleset): RulesetManifest {
  const { props } = ruleset;
  return {
    name: ruleset.rulesetName,
    target: props.target ?? 'branch',
    enforcement: props.enforcement ?? 'active',
    conditions: props.conditions,
    rules: props.rules,
    bypassActors: props.bypassActors,
  };
}

function toCodeSecurityManifest(
  config: CodeSecurityConfiguration,
): CodeSecurityConfigurationManifest {
  const { props } = config;
  if (props.attach && props.attachRepositories) {
    throw new Error(
      `Code security configuration "${config.configurationName}" sets both \`attach\` and \`attachRepositories\`. Choose a scope or a repository list, not both.`,
    );
  }
  return { ...props, name: config.configurationName };
}

function toCustomPropertyManifest(
  property: CustomProperty,
): CustomPropertyManifest {
  const { props } = property;
  const selectTypes = ['single_select', 'multi_select'];
  if (selectTypes.includes(props.valueType) && !props.allowedValues?.length) {
    throw new Error(
      `Custom property "${property.propertyName}" is a ${props.valueType} but declares no allowedValues.`,
    );
  }
  return { ...props, name: property.propertyName };
}

function assertUniqueNames(
  items: Array<{ name: string }> | undefined,
  kind: string,
): void {
  const seen = new Set<string>();
  for (const item of items ?? []) {
    if (seen.has(item.name)) {
      throw new Error(`Duplicate ${kind} name "${item.name}".`);
    }
    seen.add(item.name);
  }
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

function isTeam(c: IConstruct): c is Team {
  return c instanceof Team;
}
