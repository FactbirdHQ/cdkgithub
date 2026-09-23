import type { LiveBranchProtection, LiveRuleset } from '../github/client.ts';
import type { ResolvedBypassActor } from '../synth/governance.ts';
import type {
  ActionsPolicyManifest,
  BranchProtectionManifest,
  CodeSecurityConfigurationManifest,
  CustomPropertyManifest,
  DesiredState,
  ResolvedRuleset,
} from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';
import { resolveRuleset } from './resolve-actors.ts';
import { matchesSubset } from './subset.ts';

/**
 * Diff the governance surfaces: org settings, the Actions policy, rulesets, code
 * security configurations, and custom properties.
 *
 * Each surface is skipped entirely unless the definition declares it, and within
 * a surface only declared fields are compared — see {@link matchesSubset} for why
 * comparing anything more would report a change on every run.
 *
 * Ordering matters to the applier: custom properties are created before the
 * rulesets that target them, and code security configurations are created before
 * they can be made the default or attached to anything.
 */
export function planGovernance(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  return [
    ...planOrgSettings(desired, live),
    ...planActionsPolicy(desired, live),
    ...planCustomProperties(desired, live),
    ...planSecurityConfigurations(desired, live),
    ...planRulesets(desired, live),
    ...planBranchProtection(desired, live),
  ];
}

// ---------------------------------------------------------------------------
// Legacy branch protection
// ---------------------------------------------------------------------------

/**
 * Diff each declared branch. Nothing is pruned: there is no endpoint listing the
 * protected branches of an org, so a branch the definition does not name is one
 * cdkgithub cannot see. Removing protection is declared with `enabled: false`
 * instead.
 */
function planBranchProtection(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const declared = desired.branchProtection;
  if (!declared) return [];

  const liveByBranch = new Map(
    (live.branchProtection ?? []).map(
      (p) => [`${p.repository}#${p.branch}`, p] as const,
    ),
  );
  const changes: Change[] = [];

  for (const protection of declared) {
    const current = liveByBranch.get(
      `${protection.repository}#${protection.branch}`,
    );

    if (protection.enabled === false) {
      if (current?.enabled) {
        changes.push({
          kind: 'remove-branch-protection',
          repository: protection.repository,
          branch: protection.branch,
        });
      }
      continue;
    }

    const fields = diffBranchProtection(protection, current);
    if (fields.length > 0) {
      changes.push({ kind: 'branch-protection', protection, fields });
    }
  }

  return changes;
}

function diffBranchProtection(
  desired: BranchProtectionManifest,
  live: LiveBranchProtection | undefined,
): FieldChange[] {
  if (!live?.enabled) {
    return [{ field: 'protection', from: 'none', to: 'declared' }];
  }

  const {
    repository: _repository,
    branch: _branch,
    enabled: _enabled,
    ...settings
  } = desired;
  return diffDeclared(settings, live);
}

// ---------------------------------------------------------------------------
// Organization settings
// ---------------------------------------------------------------------------

function planOrgSettings(desired: DesiredState, live: LiveState): Change[] {
  if (!desired.settings) return [];
  const fields = diffDeclared(desired.settings, live.settings ?? {});
  if (fields.length === 0) return [];
  return [{ kind: 'org-settings', settings: desired.settings, fields }];
}

// ---------------------------------------------------------------------------
// Actions policy
// ---------------------------------------------------------------------------

function planActionsPolicy(desired: DesiredState, live: LiveState): Change[] {
  const policy = desired.actions;
  if (!policy) return [];

  const fields = diffDeclared(
    withoutSelectedRepositories(policy),
    live.actions ?? {},
  );

  // The selected-repository list is a separate endpoint and a set, not a scalar.
  if (policy.selectedRepositories) {
    const liveRepos = live.actions?.selectedRepositories ?? [];
    if (!matchesSubset(policy.selectedRepositories, liveRepos)) {
      fields.push({
        field: 'selectedRepositories',
        from: liveRepos,
        to: policy.selectedRepositories,
      });
    }
  }

  if (fields.length === 0) return [];
  return [{ kind: 'actions-policy', policy, fields }];
}

function withoutSelectedRepositories(
  policy: ActionsPolicyManifest,
): Omit<ActionsPolicyManifest, 'selectedRepositories'> {
  const { selectedRepositories: _ignored, ...rest } = policy;
  return rest;
}

// ---------------------------------------------------------------------------
// Custom properties
// ---------------------------------------------------------------------------

function planCustomProperties(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const properties = desired.customProperties;
  if (!properties) return [];

  const liveByName = new Map(
    (live.customProperties ?? []).map((p) => [p.name, p]),
  );
  const changes: Change[] = [];

  for (const property of properties) {
    const current = liveByName.get(property.name);
    if (!current) {
      changes.push({ kind: 'create-property', property });
    } else {
      const fields = diffDeclared(schemaOf(property), current);
      if (fields.length > 0) {
        changes.push({ kind: 'update-property', property, fields });
      }
    }

    const values = planPropertyValues(property, live);
    if (values) changes.push(values);
  }

  const declared = new Set(properties.map((p) => p.name));
  for (const current of live.customProperties ?? []) {
    if (!declared.has(current.name)) {
      changes.push({ kind: 'delete-property', live: current });
    }
  }

  return changes;
}

/** The property's schema, without the per-repository values that live elsewhere. */
function schemaOf(
  property: CustomPropertyManifest,
): Omit<CustomPropertyManifest, 'values'> {
  const { values: _ignored, ...schema } = property;
  return schema;
}

function planPropertyValues(
  property: CustomPropertyManifest,
  live: LiveState,
): Change | undefined {
  if (!property.values) return undefined;

  const liveByRepo = new Map(
    (live.repositoryProperties ?? []).map((r) => [r.repository, r.properties]),
  );

  const differing: Record<string, string | string[] | null> = {};
  for (const [repository, value] of Object.entries(property.values)) {
    const current = liveByRepo.get(repository)?.[property.name];
    if (!matchesSubset(value, current ?? null)) differing[repository] = value;
  }

  if (Object.keys(differing).length === 0) return undefined;
  return {
    kind: 'property-values',
    propertyName: property.name,
    values: differing,
  };
}

// ---------------------------------------------------------------------------
// Code security configurations
// ---------------------------------------------------------------------------

function planSecurityConfigurations(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const configs = desired.codeSecurityConfigurations;
  if (!configs) return [];

  // GitHub ships its own `global` presets ("GitHub recommended" and friends).
  // They cannot be edited or deleted, so they are not candidates for pruning.
  const liveConfigs = (live.securityConfigurations ?? []).filter(
    (c) => c.targetType !== 'global',
  );
  const liveByName = new Map(liveConfigs.map((c) => [c.name, c]));
  const changes: Change[] = [];

  for (const config of configs) {
    const current = liveByName.get(config.name);
    if (!current) {
      changes.push({ kind: 'create-security-config', config });
    } else {
      const fields = diffDeclared(featuresOf(config), current);
      if (fields.length > 0) {
        changes.push({
          kind: 'update-security-config',
          id: current.id,
          config,
          fields,
        });
      }
    }

    const asDefault = planSecurityDefault(config, live);
    if (asDefault) changes.push(asDefault);

    if (config.attach) {
      changes.push({
        kind: 'attach-security-config',
        configName: config.name,
        scope: config.attach,
      });
    } else if (config.attachRepositories?.length) {
      changes.push({
        kind: 'attach-security-config',
        configName: config.name,
        scope: 'selected',
        repositories: config.attachRepositories,
      });
    }
  }

  const declared = new Set(configs.map((c) => c.name));
  for (const current of liveConfigs) {
    if (!declared.has(current.name)) {
      changes.push({ kind: 'delete-security-config', live: current });
    }
  }

  return changes;
}

/** The feature settings, without the attachment fields that live on repositories. */
function featuresOf(
  config: CodeSecurityConfigurationManifest,
): Partial<CodeSecurityConfigurationManifest> {
  const {
    defaultForNewRepos: _default,
    attach: _attach,
    attachRepositories: _repos,
    ...features
  } = config;
  return features;
}

function planSecurityDefault(
  config: CodeSecurityConfigurationManifest,
  live: LiveState,
): Change | undefined {
  const scope = config.defaultForNewRepos;
  if (!scope) return undefined;

  const current = (live.defaultSecurityConfigurations ?? []).find(
    (d) => d.defaultForNewRepos === scope,
  );
  if (current?.configurationName === config.name) return undefined;

  return {
    kind: 'default-security-config',
    configName: config.name,
    scope,
    from: current?.configurationName,
  };
}

// ---------------------------------------------------------------------------
// Rulesets
// ---------------------------------------------------------------------------

function planRulesets(desired: DesiredState, live: LiveState): Change[] {
  const rulesets = desired.rulesets;
  if (!rulesets) return [];

  // Enterprise rulesets are inherited, not owned by this org, so they are read
  // past rather than pruned.
  const liveRulesets = (live.rulesets ?? []).filter(
    (r) => r.sourceType !== 'Enterprise',
  );
  const liveByName = new Map(liveRulesets.map((r) => [r.name, r]));
  const changes: Change[] = [];

  for (const declared of rulesets) {
    // Names become ids before anything is compared, so both sides of the diff
    // speak the same language.
    const ruleset = resolveRuleset(declared, live);
    const current = liveByName.get(ruleset.name);

    if (!current) {
      changes.push({ kind: 'create-ruleset', ruleset });
      continue;
    }
    const fields = diffRuleset(ruleset, current);
    if (fields.length > 0) {
      changes.push({
        kind: 'update-ruleset',
        id: current.id,
        ruleset,
        fields,
      });
    }
  }

  const declared = new Set(rulesets.map((r) => r.name));
  for (const current of liveRulesets) {
    if (!declared.has(current.name)) {
      changes.push({ kind: 'delete-ruleset', live: current });
    }
  }

  return changes;
}

/** Shared with the repository-ruleset planner, which diffs the same shape. */
export function diffRuleset(
  desired: ResolvedRuleset,
  live: LiveRuleset,
): FieldChange[] {
  const fields: FieldChange[] = [];

  if (desired.target !== live.target) {
    fields.push({ field: 'target', from: live.target, to: desired.target });
  }
  if (desired.enforcement !== live.enforcement) {
    fields.push({
      field: 'enforcement',
      from: live.enforcement,
      to: desired.enforcement,
    });
  }
  if (!matchesSubset(desired.conditions ?? {}, live.conditions ?? {})) {
    fields.push({
      field: 'conditions',
      from: live.conditions,
      to: desired.conditions,
    });
  }
  if (!matchesSubset(desired.rules, live.rules)) {
    fields.push({ field: 'rules', from: live.rules, to: desired.rules });
  }
  const desiredActors = (desired.bypassActors ?? []).map(normalizeBypassActor);
  const liveActors = live.bypassActors.map(normalizeBypassActor);
  if (!matchesSubset(desiredActors, liveActors)) {
    fields.push({
      field: 'bypassActors',
      from: live.bypassActors,
      to: desired.bypassActors ?? [],
    });
  }

  return fields;
}

/**
 * GitHub's ruleset endpoints disagree on `OrganizationAdmin`'s id: the
 * organization endpoints report `actor_id: 1`, the repository endpoints
 * report `actor_id: null` for the same actor, and writes take 1 at either
 * scope. Both sides compare as 1, or a repository ruleset with an admin
 * bypass diffs as changed on every run.
 */
function normalizeBypassActor(actor: ResolvedBypassActor): ResolvedBypassActor {
  return actor.actorType === 'OrganizationAdmin' && actor.actorId == null
    ? { ...actor, actorId: 1 }
    : actor;
}

// ---------------------------------------------------------------------------
// Shared field diffing
// ---------------------------------------------------------------------------

/**
 * Compare the fields a definition declares against the live resource, one field
 * at a time so the plan can name what changes. Nested objects are walked and
 * reported with dotted paths; arrays are compared whole, order-insensitively.
 */
export function diffDeclared(
  desired: object,
  live: object,
  prefix = '',
): FieldChange[] {
  const fields: FieldChange[] = [];
  const current = live as Record<string, unknown>;

  for (const [key, value] of Object.entries(desired)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const liveValue = current[key];

    if (isPlainObject(value)) {
      fields.push(
        ...diffDeclared(value, isPlainObject(liveValue) ? liveValue : {}, path),
      );
      continue;
    }

    if (!matchesSubset(value, liveValue)) {
      fields.push({ field: path, from: liveValue, to: value });
    }
  }

  return fields;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
