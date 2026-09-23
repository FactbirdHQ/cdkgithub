/**
 * `cdkgithub import` reads a live organization and emits a definition file,
 * the inverse of `synth`, for adopting an organization that was built by hand.
 *
 * The importer covers the team structure (hierarchy, rosters, grants) and the
 * organization-wide governance: settings, the Actions policy, custom repository
 * roles, organization role assignments, rulesets, code security configurations,
 * custom properties with their values, runner groups, and Actions variables
 * and secrets. Repository-scoped surfaces (repository rulesets, repository
 * secrets and variables) are not enumerated, because there is no listing
 * short of walking every repository. Secrets come back as names only, so each
 * is emitted reading its value from an environment variable of the same name.
 *
 * A surface the token or the plan cannot read is skipped and named in the
 * generated header, not failed on: an importer that dies on the first missing
 * feature produces nothing at all.
 */

import type {
  GitHubClient,
  LiveAppInstallation,
  LiveTeam,
  LiveTeamMember,
  LiveTeamRepository,
} from '../github/client.ts';
import { comparableRoleName } from '../github/client.ts';
import type {
  ResolvedBypassActor,
  RulesetBypassActor,
} from '../synth/manifest.ts';

export async function importOrganization(
  client: GitHubClient,
  org: string,
): Promise<string> {
  const skipped: string[] = [];
  const optional = async <T>(
    surface: string,
    read: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      skipped.push(
        `${surface} (${error instanceof Error ? error.message : String(error)})`,
      );
      return undefined;
    }
  };

  const teams = await client.listTeams(org);
  const details = new Map<
    string,
    { repos: LiveTeamRepository[]; members: LiveTeamMember[] }
  >();
  for (const team of teams) {
    details.set(team.slug, {
      repos: await client.listTeamRepositories(org, team.slug),
      members: await client.listTeamMembers(org, team.slug),
    });
  }

  const [
    settings,
    actions,
    customRoles,
    orgRoles,
    rulesets,
    appInstallations,
    securityConfigurations,
    securityDefaults,
    customProperties,
    repositoryProperties,
    runnerGroups,
    orgVariables,
    orgSecrets,
  ] = await Promise.all([
    optional('organization settings', () => client.getOrgSettings(org)),
    optional('Actions policy', () => client.getActionsPolicy(org)),
    optional('custom repository roles', () =>
      client.listCustomRepositoryRoles(org),
    ),
    optional('organization roles', async () => {
      const roles = await client.listOrganizationRoles(org);
      return Promise.all(
        roles.map(async (role) => ({
          ...role,
          ...(await client.readRoleAssignment(org, role.id)),
        })),
      );
    }),
    optional('rulesets', () => client.listRulesets(org)),
    optional('app installations', () => client.listAppInstallations(org)),
    optional('code security configurations', () =>
      client.listSecurityConfigurations(org),
    ),
    optional('code security defaults', () =>
      client.listDefaultSecurityConfigurations(org),
    ),
    optional('custom properties', () => client.listCustomProperties(org)),
    optional('custom property values', () =>
      client.listRepositoryProperties(org),
    ),
    optional('runner groups', () => client.listRunnerGroups(org)),
    optional('Actions variables', () => client.listOrgVariables(org)),
    optional('Actions secrets', () => client.listOrgSecrets(org)),
  ]);

  const emit = new Emitter(org, skipped);

  emit.organization(settings ?? {});
  for (const role of customRoles ?? []) {
    emit.construct('CustomRepositoryRole', role.name, {
      description: role.description ?? '',
      baseRole: comparableRoleName(role.baseRole),
      permissions: role.permissions,
    });
  }
  for (const role of orgRoles ?? []) {
    if (role.teams.length === 0 && role.users.length === 0) continue;
    emit.construct('OrganizationRole', role.name, {
      teams: role.teams.length > 0 ? role.teams : undefined,
      users: role.users.length > 0 ? role.users : undefined,
    });
  }

  emit.teams(teams, details);

  if (actions) {
    emit.construct('ActionsPolicy', 'actions', {
      enabledRepositories: actions.enabledRepositories,
      selectedRepositories: actions.selectedRepositories,
      allowedActions: actions.allowedActions,
      allowedActionsConfig: actions.allowedActionsConfig,
      defaultWorkflowPermissions: actions.defaultWorkflowPermissions,
      canApprovePullRequestReviews: actions.canApprovePullRequestReviews,
    });
  }

  for (const ruleset of rulesets ?? []) {
    // Enterprise rulesets are inherited, not this organization's to declare.
    if (ruleset.sourceType === 'Enterprise') continue;
    emit.construct('Ruleset', ruleset.name, {
      target: ruleset.target,
      enforcement: ruleset.enforcement,
      conditions: ruleset.conditions,
      rules: ruleset.rules,
      bypassActors: unresolveBypassActors(
        ruleset.bypassActors,
        teams,
        appInstallations ?? [],
      ),
    });
  }

  const defaultsByName = new Map(
    (securityDefaults ?? [])
      .filter((d) => d.configurationName !== undefined)
      .map((d) => [d.configurationName, d.defaultForNewRepos] as const),
  );
  for (const config of securityConfigurations ?? []) {
    // GitHub's own presets cannot be managed, so they are not declared either.
    if (config.targetType === 'global') continue;
    emit.construct('CodeSecurityConfiguration', config.name, {
      description: config.description ?? '',
      advancedSecurity: config.advancedSecurity,
      dependencyGraph: config.dependencyGraph,
      dependencyGraphAutosubmitAction: config.dependencyGraphAutosubmitAction,
      dependabotAlerts: config.dependabotAlerts,
      dependabotSecurityUpdates: config.dependabotSecurityUpdates,
      codeScanningDefaultSetup: config.codeScanningDefaultSetup,
      secretScanning: config.secretScanning,
      secretScanningPushProtection: config.secretScanningPushProtection,
      secretScanningValidityChecks: config.secretScanningValidityChecks,
      secretScanningNonProviderPatterns:
        config.secretScanningNonProviderPatterns,
      privateVulnerabilityReporting: config.privateVulnerabilityReporting,
      enforcement: config.enforcement,
      defaultForNewRepos: defaultsByName.get(config.name),
    });
  }

  for (const property of customProperties ?? []) {
    const values: Record<string, string | string[]> = {};
    for (const repo of repositoryProperties ?? []) {
      const value = repo.properties[property.name];
      if (value !== null && value !== undefined) {
        values[repo.repository] = value;
      }
    }
    emit.construct('CustomProperty', property.name, {
      valueType: property.valueType,
      required: property.required,
      defaultValue: property.defaultValue ?? undefined,
      description: property.description ?? undefined,
      allowedValues: property.allowedValues ?? undefined,
      valuesEditableBy: property.valuesEditableBy ?? undefined,
      values: Object.keys(values).length > 0 ? values : undefined,
    });
  }

  for (const group of runnerGroups ?? []) {
    emit.construct('RunnerGroup', group.name, {
      visibility: group.visibility,
      selectedRepositories: group.selectedRepositories,
      allowsPublicRepositories: group.allowsPublicRepositories || undefined,
      restrictedToWorkflows: group.restrictedToWorkflows || undefined,
      selectedWorkflows:
        group.selectedWorkflows.length > 0
          ? group.selectedWorkflows
          : undefined,
    });
  }

  for (const variable of orgVariables ?? []) {
    emit.construct('ActionsVariable', variable.name, {
      value: variable.value,
      visibility: variable.visibility,
      selectedRepositories: variable.selectedRepositories,
    });
  }

  if (orgSecrets?.length) {
    emit.comment(
      'Secret values are unreadable, so each secret reads its value from an\n' +
        'environment variable of its own name. Export them before `apply`.',
    );
    for (const secret of orgSecrets) {
      emit.construct('ActionsSecret', secret.name, {
        visibility: secret.visibility,
        selectedRepositories: secret.selectedRepositories,
      });
    }
  }

  return emit.render();
}

/**
 * Turn the numeric bypass actors GitHub stores back into the named form the
 * authoring API takes, so the generated definition reads and resolves the way
 * a hand-written one does. An id that matches nothing (a team or app since
 * removed) stays numeric, which the types accept and the plan passes through.
 */
function unresolveBypassActors(
  actors: ResolvedBypassActor[],
  teams: LiveTeam[],
  apps: LiveAppInstallation[],
): RulesetBypassActor[] | undefined {
  if (actors.length === 0) return undefined;
  const teamById = new Map(teams.map((t) => [t.id, t.slug]));
  const appById = new Map(apps.map((a) => [a.appId, a.slug]));

  return actors.map((actor): RulesetBypassActor => {
    const bypassMode = actor.bypassMode;
    switch (actor.actorType) {
      case 'OrganizationAdmin':
        return { actorType: 'OrganizationAdmin', bypassMode };
      case 'DeployKey':
        return { actorType: 'DeployKey', bypassMode };
      case 'RepositoryRole':
        return {
          actorType: 'RepositoryRole',
          roleId: actor.actorId ?? 0,
          bypassMode,
        };
      case 'Team':
        return {
          actorType: 'Team',
          team: teamById.get(actor.actorId ?? -1) ?? actor.actorId ?? 0,
          bypassMode,
        };
      case 'Integration':
        return {
          actorType: 'Integration',
          app: appById.get(actor.actorId ?? -1) ?? actor.actorId ?? 0,
          bypassMode,
        };
    }
  });
}

// ---------------------------------------------------------------------------
// Code emission
// ---------------------------------------------------------------------------

/** Constructs in the order their import specifiers should be listed. */
const IMPORT_ORDER = [
  'ActionsPolicy',
  'ActionsSecret',
  'ActionsVariable',
  'App',
  'CodeSecurityConfiguration',
  'CustomProperty',
  'CustomRepositoryRole',
  'Organization',
  'OrganizationRole',
  'RunnerGroup',
  'Ruleset',
  'Team',
];

class Emitter {
  private readonly chunks: string[] = [];
  private readonly used = new Set<string>(['App', 'Organization']);

  constructor(
    private readonly org: string,
    private readonly skipped: string[],
  ) {}

  organization(settings: object): void {
    const props: Record<string, unknown> = { login: this.org };
    if (Object.values(settings).some((v) => v !== undefined)) {
      props.settings = settings;
    }
    this.chunks.push(
      `const org = new Organization(app, ${lit(this.org)}, ${lit(props)});`,
      '',
    );
  }

  comment(text: string): void {
    this.chunks.push(...text.split('\n').map((line) => `// ${line}`));
  }

  construct(type: string, id: string, props: Record<string, unknown>): void {
    this.used.add(type);
    this.chunks.push(`new ${type}(org, ${lit(id)}, ${lit(props)});`, '');
  }

  /**
   * The team tree, nested the way the hierarchy nests: a child team is
   * declared against its parent's variable, so the generated file reads like
   * the org chart it mirrors.
   */
  teams(
    teams: LiveTeam[],
    details: ReadonlyMap<
      string,
      { repos: LiveTeamRepository[]; members: LiveTeamMember[] }
    >,
  ): void {
    if (teams.length === 0) return;
    this.used.add('Team');

    const childrenOf = (slug: string | null) =>
      teams
        .filter((t) => t.parentSlug === slug)
        .sort((a, b) => a.slug.localeCompare(b.slug));

    // GitHub reports a descendant team's people as members of every team
    // above it. Subtracting them leaves each roster holding only the people
    // the team has in its own right, which is what a declarative roster means.
    const inheritedInto = (slug: string): Set<string> => {
      const inherited = new Set<string>();
      const walk = (parent: string) => {
        for (const child of childrenOf(parent)) {
          for (const member of details.get(child.slug)?.members ?? []) {
            inherited.add(member.login);
          }
          walk(child.slug);
        }
      };
      walk(slug);
      return inherited;
    };

    const names = new VariableNames();
    const emitSubtree = (team: LiveTeam, scope: string) => {
      const children = childrenOf(team.slug);
      const variable = children.length > 0 ? names.for(team.slug) : undefined;
      const declaration = variable ? `const ${variable} = ` : '';
      this.chunks.push(
        `${declaration}new Team(${scope}, ${lit(team.slug)}, ${lit(
          this.teamProps(team, details, inheritedInto(team.slug)),
        )});`,
        '',
      );
      for (const child of children) emitSubtree(child, variable!);
    };

    for (const root of childrenOf(null)) emitSubtree(root, 'org');
  }

  private teamProps(
    team: LiveTeam,
    details: ReadonlyMap<
      string,
      { repos: LiveTeamRepository[]; members: LiveTeamMember[] }
    >,
    inherited: ReadonlySet<string>,
  ): Record<string, unknown> {
    const detail = details.get(team.slug);
    const maintainers = (detail?.members ?? [])
      .filter((m) => m.role === 'maintainer')
      .map((m) => m.login)
      .sort();
    const members = (detail?.members ?? [])
      .filter((m) => m.role === 'member' && !inherited.has(m.login))
      .map((m) => m.login)
      .sort();
    const repositories = Object.fromEntries(
      [...(detail?.repos ?? [])]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => [r.name, comparableRoleName(r.roleName)]),
    );

    return {
      name: team.name !== team.slug ? team.name : undefined,
      description: team.description ?? undefined,
      privacy: team.privacy !== 'closed' ? team.privacy : undefined,
      maintainers: maintainers.length > 0 ? maintainers : undefined,
      members: members.length > 0 ? members : undefined,
      repositories:
        Object.keys(repositories).length > 0 ? repositories : undefined,
    };
  }

  render(): string {
    const specifiers = IMPORT_ORDER.filter((name) => this.used.has(name));
    const notes =
      this.skipped.length > 0
        ? ` *
 * Surfaces the import could not read, left for a hand that can:
${this.skipped.map((s) => ` *   - ${s}`).join('\n')}
`
        : '';

    return `/**
 * The ${this.org} organization, imported from the live state by
 * \`cdkgithub import ${this.org}\` as a starting point for managing it
 * declaratively. Edit, then \`synth\` and \`diff\` until the diff is quiet.
 *
 * Child teams inherit their parent's repository access on GitHub, so a child
 * re-declaring a parent's grant is redundant; \`diff\` names those grants.
${notes} */
import {
${specifiers.map((s) => `  ${s},`).join('\n')}
} from "../src/index.ts";

const app = new App();

${this.chunks.join('\n').trimEnd()}

app.synth();
`;
  }
}

/**
 * Distinct, legal variable names for the team constants. A slug camelCases
 * into a name; one that collides with a keyword, an emitted binding, or an
 * earlier team gets a numbered suffix rather than a compile error.
 */
class VariableNames {
  private readonly taken = new Set<string>(['app', 'org']);

  for(slug: string): string {
    let base = slug.replace(/[^a-zA-Z0-9]+([a-zA-Z0-9])/g, (_, c: string) =>
      c.toUpperCase(),
    );
    base = base.replace(/[^a-zA-Z0-9_$]/g, '');
    if (!/^[a-zA-Z_$]/.test(base) || RESERVED.has(base)) base = `team${base ? base[0]!.toUpperCase() + base.slice(1) : ''}`;
    let name = base;
    for (let i = 2; this.taken.has(name); i++) name = `${base}${i}`;
    this.taken.add(name);
    return name;
  }
}

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/**
 * A TypeScript literal for a JSON-shaped value: identifier keys unquoted,
 * `undefined` entries dropped, and anything that would crowd a line broken
 * across several. What this prints is what the generated file is made of.
 */
function lit(value: unknown, indent = ''): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inline = `[${value.map((v) => lit(v, indent)).join(', ')}]`;
    if (fits(inline, indent)) return inline;
    const inner = `${indent}  `;
    return `[\n${value
      .map((v) => `${inner}${lit(v, inner)},`)
      .join('\n')}\n${indent}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  if (entries.length === 0) return '{}';
  const inline = `{ ${entries
    .map(([k, v]) => `${key(k)}: ${lit(v, indent)}`)
    .join(', ')} }`;
  if (fits(inline, indent)) return inline;
  const inner = `${indent}  `;
  return `{\n${entries
    .map(([k, v]) => `${inner}${key(k)}: ${lit(v, inner)},`)
    .join('\n')}\n${indent}}`;
}

function fits(rendered: string, indent: string): boolean {
  return !rendered.includes('\n') && indent.length + rendered.length <= 72;
}

function key(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}
