import type { IConstruct } from 'constructs';
import { ActionsPolicy } from '../constructs/actions-policy.ts';
import { ActionsSecret } from '../constructs/actions-secret.ts';
import { ActionsVariable } from '../constructs/actions-variable.ts';
import { Environment } from '../constructs/environment.ts';
import { BranchProtection } from '../constructs/branch-protection.ts';
import { CodeSecurityConfiguration } from '../constructs/code-security.ts';
import { CustomProperty } from '../constructs/custom-property.ts';
import { Organization } from '../constructs/organization.ts';
import { CustomRepositoryRole } from '../constructs/custom-repository-role.ts';
import { OrganizationRole } from '../constructs/organization-role.ts';
import { Repository } from '../constructs/repository.ts';
import { RepositoryRuleset } from '../constructs/repository-ruleset.ts';
import { RunnerGroup } from '../constructs/runner-group.ts';
import { Ruleset } from '../constructs/ruleset.ts';
import { ScimProvisioning } from '../constructs/scim-provisioning.ts';
import type {
  RepositoryGrant,
  RepositoryGrantList,
} from '../constructs/grants.ts';
import { Team } from '../constructs/team.ts';
import { UserAccount } from '../constructs/user-account.ts';
import type {
  ActionsSecretManifest,
  ActionsVariableManifest,
  EnvironmentManifest,
} from './actions-admin.ts';
import type { BranchProtectionManifest } from './branch-protection.ts';
import type {
  ActionsPolicyManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  RepositoryRulesetManifest,
  RulesetManifest,
} from './governance.ts';
import type { ScimProvisioningManifest } from './scim.ts';
import type {
  DesiredState,
  RepoPermission,
  RepositoryAccess,
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
  assertSingleMaintainer(teams);
  assertNoDuplicateGrants(root.node.findAll().filter(isTeam));

  const branchProtection = collect(root, BranchProtection, toBranchProtection);
  // What a repository contains is collected from the constructs it made, so
  // only what it is created with reaches its manifest.
  const repositories = collect(root, Repository, (r) => {
    const {
      environment: _environment,
      variable: _variable,
      secret: _secret,
      ruleset: _ruleset,
      branchProtection: _branchProtection,
      ...props
    } = r.props;
    return { name: r.repositoryName, ...props };
  });
  const rulesets = collect(root, Ruleset, toRulesetManifest);
  const customRepositoryRoles = collect(root, CustomRepositoryRole, (r) => ({
    name: r.roleName,
    ...r.props,
  }));
  const organizationRoles = collect(root, OrganizationRole, (r) => ({
    name: r.roleName,
    ...r.props,
  }));
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
  const repositoryRulesets = collect(
    root,
    RepositoryRuleset,
    toRepositoryRulesetManifest,
  );
  const runnerGroups = collect(root, RunnerGroup, (g) => ({
    name: g.groupName,
    ...g.props,
  }));
  const actionsVariables = collect(root, ActionsVariable, toVariableManifest);
  const actionsSecrets = collect(root, ActionsSecret, toSecretManifest);
  const environments = collect(root, Environment, toEnvironmentManifest);

  assertUniqueNames(repositories, 'repository');
  assertUniqueNames(rulesets, 'ruleset');
  assertUniqueNames(organizationRoles, 'organization role');
  assertUniqueNames(customRepositoryRoles, 'custom repository role');
  assertUniqueNames(codeSecurityConfigurations, 'code security configuration');
  assertUniqueNames(customProperties, 'custom property');
  assertUniqueNames(runnerGroups, 'runner group');
  assertUniquePerRepository(repositoryRulesets, 'repository ruleset', false);
  assertUniquePerRepository(actionsVariables, 'variable');
  assertUniquePerRepository(actionsSecrets, 'secret');
  assertUniquePerRepository(environments, 'environment', false);

  const state: DesiredState = {
    owner: owner.login,
    ownerType: owner.type,
    teams,
    settings: owner.settings,
    actions: singleActionsPolicy(root),
    repositories,
    rulesets,
    customRepositoryRoles,
    organizationRoles,
    codeSecurityConfigurations,
    customProperties,
    branchProtection,
    repositoryRulesets,
    runnerGroups,
    actionsVariables,
    actionsSecrets,
    environments,
    scim: singleScimProvisioning(root, owner.login, teams),
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
    ['RunnerGroup', state.runnerGroups],
    // The repository-scoped entries work on a personal account's repositories;
    // only the organization-scoped ones have nothing to live on.
    [
      'organization ActionsVariable',
      state.actionsVariables?.some((v) => !v.repository) || undefined,
    ],
    [
      'organization ActionsSecret',
      state.actionsSecrets?.some((s) => !s.repository) || undefined,
    ],
    ['ScimProvisioning', state.scim],
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

/** The repository an environment belongs to: the one it names, or the one it sits in. */
function repositoryOf(environment: Environment): string | undefined {
  return (
    environment.props.repository ??
    nearestRepository(environment)?.repositoryName
  );
}

/** The environment a variable or secret sits in, if any. */
function nearestEnvironment(construct: IConstruct): Environment | undefined {
  let scope = construct.node.scope;
  while (scope) {
    if (scope instanceof Environment) return scope;
    scope = scope.node.scope;
  }
  return undefined;
}

/**
 * Where a variable or secret lives. One nested under an {@link Environment}
 * takes the environment and its repository from there, and naming a different
 * environment of its own is a contradiction worth failing on.
 */
function scopeOf(
  construct: IConstruct,
  props: { repository?: string; environment?: string },
  what: string,
): { repository?: string; environment?: string } {
  const around = nearestEnvironment(construct);
  if (around && props.environment && props.environment !== around.environmentName) {
    throw new Error(
      `${what} sits in environment "${around.environmentName}" but names environment "${props.environment}".`,
    );
  }
  return {
    repository:
      props.repository ??
      (around ? repositoryOf(around) : nearestRepository(construct)?.repositoryName),
    environment: props.environment ?? around?.environmentName,
  };
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

/**
 * Resolve the single SCIM provisioning declaration, defaulting its group list
 * from the definition itself: every group name a team's `externalGroup`
 * binds. Deriving the list is the point of declaring both in one place, so a
 * team added with a new group is provisioned by the next `scim` run without
 * a second edit. A declaration that resolves to no groups would configure an
 * application that pushes nothing, which is a mistake, not a choice.
 */
function singleScimProvisioning(
  root: IConstruct,
  login: string,
  teams: TeamManifest[],
): ScimProvisioningManifest | undefined {
  const declarations = root.node
    .findAll()
    .filter((c): c is ScimProvisioning => c instanceof ScimProvisioning);
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new Error(
      `Expected at most one ScimProvisioning, found ${declarations.length}. One application provisions the organization.`,
    );
  }

  const { props } = declarations[0]!;
  const groups =
    props.groups ??
    [
      ...new Set(
        teams.flatMap((t) =>
          t.externalGroup?.name ? [t.externalGroup.name] : [],
        ),
      ),
    ].sort();
  if (groups.length === 0) {
    throw new Error(
      'ScimProvisioning resolves to no groups: no team declares an externalGroup name, and no `groups` were passed.',
    );
  }

  return {
    tenantId: props.tenantId,
    applicationDisplayName:
      props.applicationDisplayName ?? `GitHub SCIM (${login})`,
    tokenFrom: props.tokenFrom ?? 'GITHUB_SCIM_TOKEN',
    groups,
  };
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

/** The repository a repository-scoped construct lives on, by nesting or by name. */
function resolveRepository(
  construct: IConstruct,
  declared: string | undefined,
  what: string,
): string {
  const repository = declared ?? nearestRepository(construct)?.repositoryName;
  if (!repository) {
    throw new Error(
      `${what} names no repository. Nest it under a Repository, or pass \`repository\`.`,
    );
  }
  return repository;
}

function toRepositoryRulesetManifest(
  ruleset: RepositoryRuleset,
): RepositoryRulesetManifest {
  const { repository: declared, ...props } = ruleset.props;
  const repository = resolveRepository(
    ruleset,
    declared,
    `RepositoryRuleset "${ruleset.rulesetName}"`,
  );
  return {
    ...props,
    name: ruleset.rulesetName,
    repository,
    target: props.target ?? 'branch',
    enforcement: props.enforcement ?? 'active',
  };
}

/**
 * Visibility belongs to exactly one scope: an organization entry must say who
 * reads it, and a repository entry is read by its own repository and nobody
 * else. Both mistakes are declarations that would silently mean something
 * other than what they say, so both fail here.
 */
function assertScopedVisibility(
  what: string,
  repository: string | undefined,
  visibility: string | undefined,
): void {
  if (repository === undefined && visibility === undefined) {
    throw new Error(
      `Organization ${what} declares no visibility. Say who reads it: "all", "private", or "selected".`,
    );
  }
  if (repository !== undefined && visibility !== undefined) {
    throw new Error(
      `${what} on repository "${repository}" declares a visibility, but only its own repository reads it.`,
    );
  }
}

function toVariableManifest(
  variable: ActionsVariable,
): ActionsVariableManifest {
  const { repository, environment } = scopeOf(
    variable,
    variable.props,
    `Variable "${variable.variableName}"`,
  );
  assertScopedVisibility(
    `variable "${variable.variableName}"`,
    repository,
    variable.props.visibility,
  );
  if (environment !== undefined && repository === undefined) {
    throw new Error(
      `Variable "${variable.variableName}" names environment "${environment}" but no repository. An environment belongs to one repository: nest the variable under it or pass \`repository\`.`,
    );
  }
  return {
    ...variable.props,
    name: variable.variableName,
    repository,
    ...(environment === undefined ? {} : { environment }),
  };
}

function toSecretManifest(secret: ActionsSecret): ActionsSecretManifest {
  const { repository, environment } = scopeOf(
    secret,
    secret.props,
    `Secret "${secret.secretName}"`,
  );
  assertScopedVisibility(
    `secret "${secret.secretName}"`,
    repository,
    secret.props.visibility,
  );
  if (environment !== undefined && repository === undefined) {
    throw new Error(
      `Secret "${secret.secretName}" names environment "${environment}" but no repository. An environment belongs to one repository: nest the secret under it or pass \`repository\`.`,
    );
  }
  return {
    ...secret.props,
    name: secret.secretName,
    valueFrom: secret.props.valueFrom ?? secret.secretName,
    repository,
    ...(environment === undefined ? {} : { environment }),
  };
}

function toEnvironmentManifest(environment: Environment): EnvironmentManifest {
  const {
    repository: _repository,
    name: _name,
    variable: _variable,
    secret: _secret,
    ...settings
  } = environment.props;
  const repository = repositoryOf(environment);
  if (repository === undefined) {
    throw new Error(
      `Environment "${environment.environmentName}" names no repository. Nest it under a Repository or pass \`repository\`.`,
    );
  }
  const reviewers =
    (settings.reviewers?.teams?.length ?? 0) +
    (settings.reviewers?.users?.length ?? 0);
  if (reviewers > 6) {
    throw new Error(
      `Environment "${environment.environmentName}" on "${repository}" names ${reviewers} reviewers; GitHub allows six.`,
    );
  }
  const wait = settings.waitTimer;
  if (wait !== undefined && (!Number.isInteger(wait) || wait < 0 || wait > 43200)) {
    throw new Error(
      `Environment "${environment.environmentName}" on "${repository}" waits ${wait} minutes; GitHub accepts a whole number from 0 to 43200.`,
    );
  }
  return { repository, name: environment.environmentName, ...settings };
}

/**
 * Uniqueness within each scope, for the collections whose entries live on a
 * repository (or on the organization when they name none). GitHub compares
 * secret and variable names case-insensitively, so `token` and `TOKEN` are the
 * same entry and collide here rather than at apply; ruleset names it stores as
 * written.
 */
function assertUniquePerRepository(
  items:
    | Array<{ name: string; repository?: string; environment?: string }>
    | undefined,
  kind: string,
  caseInsensitive = true,
): void {
  const seen = new Set<string>();
  for (const item of items ?? []) {
    const name = caseInsensitive ? item.name.toUpperCase() : item.name;
    const key = `${item.repository ?? ''} ${item.environment ?? ''} ${name}`;
    if (seen.has(key)) {
      const where = item.environment
        ? `environment "${item.environment}" of repository "${item.repository}"`
        : item.repository
          ? `repository "${item.repository}"`
          : 'the organization';
      throw new Error(`Duplicate ${kind} "${item.name}" on ${where}.`);
    }
    seen.add(key);
  }
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
    previousSlug: team.props.previousSlug,
    description: team.props.description,
    privacy: team.props.privacy ?? 'closed',
    notificationSetting: team.props.notificationSetting,
    parentSlug: parent?.slug,
    // Carried through undefined rather than defaulted: the reconciler reads a
    // missing roster or access map as "not managed here" and leaves the live
    // team alone, where an empty one means "nobody, prune the rest".
    maintainers: team.props.maintainers,
    members: team.props.members,
    repositories: normalizeGrants(team.props.repositories),
    externalGroup,
  };
}

/** The list form and the map form, reduced to the one the manifest carries. */
function normalizeGrants(
  grants: RepositoryAccess | readonly RepositoryGrantList[] | undefined,
): RepositoryAccess | undefined {
  if (!Array.isArray(grants)) return grants as RepositoryAccess | undefined;
  return Object.fromEntries(
    flattenGrants(grants as readonly RepositoryGrantList[]).map((g) => [
      g.repository,
      g.permission,
    ]),
  );
}

/**
 * One list of grants out of a list of what the helpers return.
 *
 * `push('nest')` is a list of one and `triage(...systemII)` a list of many, so
 * the array a team declares is a list of lists. One level is all there is.
 */
function flattenGrants(
  grants: readonly RepositoryGrantList[],
): RepositoryGrant[] {
  return grants.flatMap((g) =>
    Array.isArray(g) ? [...g] : [g as RepositoryGrant],
  );
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

/**
 * The permissions that claim a repository rather than merely reach it.
 *
 * `maintain` is the claim, and `admin` is the same claim with more behind it:
 * a team that can delete, transfer and rename a repository answers for it at
 * least as much as one that can edit its description. Checking `maintain`
 * alone left the stronger grant as the way around the rule, which is the wrong
 * way round for an assertion about responsibility.
 */
const OWNING_PERMISSIONS = new Set(['maintain', 'admin']);

/**
 * No repository is owned by two teams.
 *
 * Ownership is the permission and the claim: it says a team answers for the
 * repository, and two answers is not a stronger claim than one, it is the
 * absence of one. Every other permission may overlap freely, because reading
 * and writing are not claims about responsibility. Read off the resolved
 * grants, so it holds for the map form as much as for `maintain("nest")`.
 *
 * Checked at synth, before anything is read or written, because the conflict is
 * in the definition and has nothing to do with the live organization.
 */
function assertSingleMaintainer(teams: TeamManifest[]): void {
  const owner = new Map<string, { slug: string; permission: string }>();
  for (const team of teams) {
    for (const [repository, permission] of Object.entries(
      team.repositories ?? {},
    )) {
      if (!OWNING_PERMISSIONS.has(permission)) continue;
      const held = owner.get(repository);
      if (held !== undefined) {
        throw new Error(
          `Repository "${repository}" is owned by both "${held.slug}" ` +
            `("${held.permission}") and "${team.slug}" ("${permission}"). ` +
            'Both permissions say a team answers for a repository, and one ' +
            'does; grant the other team a lesser permission instead.',
        );
      }
      owner.set(repository, { slug: team.slug, permission });
    }
  }
}

/**
 * No repository is granted twice within one team.
 *
 * The array form makes a duplicate easy to write and invisible to read: two
 * `push('nest')` forty lines apart, or a `push` and a `maintain`, and the last
 * one silently wins. A tuple type can be made to reject it, at the cost of an
 * error message nobody can act on, so it is asserted here where both grants can
 * be named.
 *
 * The map form cannot express the problem — an object literal with a repeated
 * key is a different error, already caught by the compiler.
 */
function assertNoDuplicateGrants(teams: Team[]): void {
  for (const team of teams) {
    const grants = team.props.repositories;
    if (!Array.isArray(grants)) continue;

    const seen = new Map<string, RepoPermission>();
    for (const { repository, permission } of flattenGrants(
      grants as readonly RepositoryGrantList[],
    )) {
      const held = seen.get(repository);
      if (held !== undefined) {
        throw new Error(
          `Team "${team.slug}" grants "${repository}" twice, as "${held}" and ` +
            `"${permission}". A repository takes one permission per team.`,
        );
      }
      seen.set(repository, permission);
    }
  }
}
