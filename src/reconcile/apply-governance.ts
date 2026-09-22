import type { GitHubClient } from '../github/client.ts';
import type { GovernanceChange } from './changes.ts';

/**
 * Everything the governance applier needs beyond the change itself: a way to
 * resolve repository names to the ids some endpoints take, and a way to find a
 * code security configuration by name once it may have just been created.
 */
export interface GovernanceContext {
  readonly client: GitHubClient;
  readonly org: string;
  /** Resolve repository names to ids, reading the org's repositories once. */
  resolveRepositoryIds(names: string[]): Promise<number[]>;
  /** Configuration id by name, including configurations created earlier in this run. */
  resolveConfigurationId(name: string): Promise<number>;
  /** Remember the id of a configuration this run just created. */
  rememberConfigurationId(name: string, id: number): void;
  log(message: string): void;
}

/**
 * Execute one governance change. Returns whether the change did anything, so the
 * caller can count it.
 *
 * Changes arrive in the order the planner produced: properties before the
 * rulesets that target them, configurations before they are defaulted or
 * attached.
 */
export async function applyGovernanceChange(
  change: GovernanceChange,
  ctx: GovernanceContext,
): Promise<void> {
  const { client, org } = ctx;

  switch (change.kind) {
    case 'org-settings':
      ctx.log(`Updating organization settings (${fieldNames(change.fields)})`);
      await client.updateOrgSettings(org, change.settings);
      return;

    case 'actions-policy': {
      const policy = change.policy;
      const changed = new Set(change.fields.map((f) => f.field));
      const changedAny = (...names: string[]) =>
        names.some((n) => changed.has(n));
      ctx.log(`Updating the Actions policy (${fieldNames(change.fields)})`);

      // The policy spans three endpoints, so each one is written only when one
      // of its own fields differs. Writing all three would re-PUT settings
      // nobody asked to change.
      if (changedAny('enabledRepositories', 'allowedActions')) {
        await client.setActionsPermissions(org, {
          enabledRepositories: policy.enabledRepositories,
          allowedActions: policy.allowedActions,
        });
      }
      // The allowlist has to be written after `allowed_actions: selected`, or
      // GitHub rejects it as not applicable.
      if (
        policy.allowedActionsConfig &&
        [...changed].some((f) => f.startsWith('allowedActionsConfig'))
      ) {
        await client.setAllowedActions(org, policy.allowedActionsConfig);
      }
      if (policy.selectedRepositories && changed.has('selectedRepositories')) {
        const ids = await ctx.resolveRepositoryIds(policy.selectedRepositories);
        await client.setActionsSelectedRepositories(org, ids);
      }
      if (
        changedAny('defaultWorkflowPermissions', 'canApprovePullRequestReviews')
      ) {
        await client.setDefaultWorkflowPermissions(org, {
          defaultWorkflowPermissions: policy.defaultWorkflowPermissions,
          canApprovePullRequestReviews: policy.canApprovePullRequestReviews,
        });
      }
      return;
    }

    case 'create-ruleset':
      ctx.log(`Creating ruleset "${change.ruleset.name}"`);
      await client.createRuleset(org, change.ruleset);
      return;

    case 'update-ruleset':
      ctx.log(
        `Updating ruleset "${change.ruleset.name}" (${fieldNames(change.fields)})`,
      );
      await client.updateRuleset(org, change.id, change.ruleset);
      return;

    case 'delete-ruleset':
      ctx.log(`Deleting ruleset "${change.live.name}"`);
      await client.deleteRuleset(org, change.live.id);
      return;

    case 'create-security-config': {
      ctx.log(`Creating code security configuration "${change.config.name}"`);
      const id = await client.createSecurityConfiguration(org, change.config);
      // The very next changes may make this configuration the default or attach
      // it, and both need its id.
      ctx.rememberConfigurationId(change.config.name, id);
      return;
    }

    case 'update-security-config':
      ctx.log(
        `Updating code security configuration "${change.config.name}" (${fieldNames(change.fields)})`,
      );
      await client.updateSecurityConfiguration(org, change.id, change.config);
      return;

    case 'delete-security-config':
      ctx.log(`Deleting code security configuration "${change.live.name}"`);
      await client.deleteSecurityConfiguration(org, change.live.id);
      return;

    case 'default-security-config': {
      ctx.log(
        `Making "${change.configName}" the default for ${change.scope} new repositories`,
      );
      const configId = await ctx.resolveConfigurationId(change.configName);
      await client.setSecurityConfigurationAsDefault(
        org,
        configId,
        change.scope,
      );
      return;
    }

    case 'attach-security-config': {
      ctx.log(
        `Attaching "${change.configName}" to ${change.scope} repositories`,
      );
      const configId = await ctx.resolveConfigurationId(change.configName);
      const repositoryIds = change.repositories
        ? await ctx.resolveRepositoryIds(change.repositories)
        : undefined;
      await client.attachSecurityConfiguration(
        org,
        configId,
        change.scope as Parameters<
          GitHubClient['attachSecurityConfiguration']
        >[2],
        repositoryIds,
      );
      return;
    }

    case 'create-property':
      ctx.log(`Creating custom property "${change.property.name}"`);
      await client.putCustomProperty(org, change.property);
      return;

    case 'update-property':
      ctx.log(
        `Updating custom property "${change.property.name}" (${fieldNames(change.fields)})`,
      );
      await client.putCustomProperty(org, change.property);
      return;

    case 'delete-property':
      ctx.log(`Deleting custom property "${change.live.name}"`);
      await client.deleteCustomProperty(org, change.live.name);
      return;

    case 'create-repo-role':
      ctx.log(`Creating repository role "${change.role.name}"`);
      await client.createCustomRepositoryRole(org, change.role);
      return;

    case 'update-repo-role':
      ctx.log(`Updating repository role "${change.role.name}"`);
      await client.updateCustomRepositoryRole(org, change.id, change.role);
      return;

    case 'delete-repo-role':
      ctx.log(`Deleting repository role "${change.live.name}"`);
      await client.deleteCustomRepositoryRole(org, change.live.id);
      return;

    case 'assign-org-role':
      ctx.log(
        `Granting org role "${change.role}" to ${change.subject} ${change.name}`,
      );
      await (change.subject === 'team'
        ? client.assignRoleToTeam(org, change.roleId, change.name)
        : client.assignRoleToUser(org, change.roleId, change.name));
      return;

    case 'revoke-org-role':
      ctx.log(
        `Revoking org role "${change.role}" from ${change.subject} ${change.name}`,
      );
      await (change.subject === 'team'
        ? client.removeRoleFromTeam(org, change.roleId, change.name)
        : client.removeRoleFromUser(org, change.roleId, change.name));
      return;

    case 'branch-protection': {
      const { protection } = change;
      ctx.log(
        `Protecting ${protection.repository}#${protection.branch} (${fieldNames(change.fields)})`,
      );
      await client.putBranchProtection(org, protection.repository, protection);
      // Signed commits have their own endpoint, so they are written after the
      // protection payload that everything else travels in.
      if (protection.requiredSignatures !== undefined) {
        await client.setSignatureProtection(
          org,
          protection.repository,
          protection.branch,
          protection.requiredSignatures,
        );
      }
      return;
    }

    case 'remove-branch-protection':
      ctx.log(
        `Removing legacy protection from ${change.repository}#${change.branch}`,
      );
      await client.deleteBranchProtection(
        org,
        change.repository,
        change.branch,
      );
      return;

    case 'property-values': {
      // One call per distinct value: the endpoint sets the same value on every
      // repository it is given.
      for (const [value, repositories] of groupByValue(change.values)) {
        ctx.log(
          `Setting ${change.propertyName}=${value} on ${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}`,
        );
        await client.setRepositoryPropertyValues(org, repositories, {
          [change.propertyName]: JSON.parse(value) as string | string[] | null,
        });
      }
      return;
    }
  }
}

/** Group repositories by the value they should get, so each value is one call. */
function groupByValue(
  values: Record<string, string | string[] | null>,
): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const [repository, value] of Object.entries(values)) {
    const key = JSON.stringify(value);
    const group = groups.get(key);
    if (group) group.push(repository);
    else groups.set(key, [repository]);
  }
  return [...groups];
}

function fieldNames(fields: ReadonlyArray<{ field: string }>): string {
  return fields.map((f) => f.field).join(', ');
}
