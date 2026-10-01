import type { GitHubClient } from '../github/client.ts';
import type { GovernanceChange } from './changes.ts';
import { policyMode } from './plan-environments.ts';

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
  /** Remember a repository this run just created, so later changes can name it. */
  rememberRepositoryId(name: string, id: number): Promise<void>;
  /** Configuration id by name, including configurations created earlier in this run. */
  resolveConfigurationId(name: string): Promise<number>;
  /** Remember the id of a configuration this run just created. */
  rememberConfigurationId(name: string, id: number): void;
  /** The slug GitHub answers to for a declared team slug, renames included. */
  resolveTeamSlug(declared: string): string;
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

    case 'create-ruleset': {
      // GitHub does not make ruleset names unique, so a create retried after a
      // lost response, or re-run after a partial apply, would enforce twice.
      // An existing ruleset of this name is adopted and updated instead.
      const existing = await client.findRulesetIdByName(
        org,
        change.ruleset.name,
      );
      if (existing !== undefined) {
        ctx.log(
          `Ruleset "${change.ruleset.name}" already exists (id ${existing}), updating it`,
        );
        await client.updateRuleset(org, existing, change.ruleset);
        return;
      }
      ctx.log(`Creating ruleset "${change.ruleset.name}"`);
      await client.createRuleset(org, change.ruleset);
      return;
    }

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

    case 'create-repo-ruleset': {
      // The same adoption as the org-level create: ruleset names are not
      // unique, so a create retried after a lost response must update rather
      // than enforce twice.
      const existing = await client.findRepositoryRulesetIdByName(
        org,
        change.repository,
        change.ruleset.name,
      );
      if (existing !== undefined) {
        ctx.log(
          `Ruleset "${change.ruleset.name}" already exists on ${change.repository} (id ${existing}), updating it`,
        );
        await client.updateRepositoryRuleset(
          org,
          change.repository,
          existing,
          change.ruleset,
        );
        return;
      }
      ctx.log(
        `Creating ruleset "${change.ruleset.name}" on ${change.repository}`,
      );
      await client.createRepositoryRuleset(
        org,
        change.repository,
        change.ruleset,
      );
      return;
    }

    case 'update-repo-ruleset':
      ctx.log(
        `Updating ruleset "${change.ruleset.name}" on ${change.repository} (${fieldNames(change.fields)})`,
      );
      await client.updateRepositoryRuleset(
        org,
        change.repository,
        change.id,
        change.ruleset,
      );
      return;

    case 'delete-repo-ruleset':
      ctx.log(
        `Deleting ruleset "${change.live.name}" from ${change.repository}`,
      );
      await client.deleteRepositoryRuleset(
        org,
        change.repository,
        change.live.id,
      );
      return;

    case 'create-runner-group': {
      ctx.log(`Creating runner group "${change.group.name}"`);
      const ids = change.group.selectedRepositories
        ? await ctx.resolveRepositoryIds(change.group.selectedRepositories)
        : undefined;
      await client.createRunnerGroup(org, change.group, ids);
      return;
    }

    case 'update-runner-group': {
      ctx.log(
        `Updating runner group "${change.group.name}" (${fieldNames(change.fields)})`,
      );
      await client.updateRunnerGroup(org, change.id, change.group);
      // The repository list has its own endpoint, so it is written only when
      // it is what differs.
      if (
        change.group.selectedRepositories &&
        change.fields.some((f) => f.field === 'selectedRepositories')
      ) {
        await client.setRunnerGroupRepositories(
          org,
          change.id,
          await ctx.resolveRepositoryIds(change.group.selectedRepositories),
        );
      }
      return;
    }

    case 'delete-runner-group':
      ctx.log(`Deleting runner group "${change.live.name}"`);
      await client.deleteRunnerGroup(org, change.live.id);
      return;

    case 'create-variable':
    case 'update-variable': {
      const variable = change.variable;
      const creating = change.kind === 'create-variable';
      if (variable.repository && variable.environment) {
        ctx.log(
          `${creating ? 'Creating' : 'Updating'} variable ${variable.name} on ${variable.repository} (${variable.environment})`,
        );
        await (creating
          ? client.createEnvironmentVariable(
              org,
              variable.repository,
              variable.environment,
              variable.name,
              variable.value,
            )
          : client.updateEnvironmentVariable(
              org,
              variable.repository,
              variable.environment,
              variable.name,
              variable.value,
            ));
        return;
      }
      if (variable.repository) {
        ctx.log(
          `${creating ? 'Creating' : 'Updating'} variable ${variable.name} on ${variable.repository}`,
        );
        await (creating
          ? client.createRepositoryVariable(
              org,
              variable.repository,
              variable.name,
              variable.value,
            )
          : client.updateRepositoryVariable(
              org,
              variable.repository,
              variable.name,
              variable.value,
            ));
        return;
      }
      ctx.log(
        `${creating ? 'Creating' : 'Updating'} organization variable ${variable.name}`,
      );
      const visibility = requireVisibility(variable.visibility, variable.name);
      const ids = variable.selectedRepositories
        ? await ctx.resolveRepositoryIds(variable.selectedRepositories)
        : undefined;
      await (creating
        ? client.createOrgVariable(org, variable.name, variable.value, visibility, ids)
        : client.updateOrgVariable(org, variable.name, variable.value, visibility, ids));
      return;
    }

    case 'delete-variable':
      if (change.repository && change.environment) {
        ctx.log(
          `Deleting variable ${change.name} from ${change.repository} (${change.environment})`,
        );
        await client.deleteEnvironmentVariable(
          org,
          change.repository,
          change.environment,
          change.name,
        );
        return;
      }
      ctx.log(
        change.repository
          ? `Deleting variable ${change.name} from ${change.repository}`
          : `Deleting organization variable ${change.name}`,
      );
      await (change.repository
        ? client.deleteRepositoryVariable(org, change.repository, change.name)
        : client.deleteOrgVariable(org, change.name));
      return;

    case 'put-secret': {
      const secret = change.secret;
      // Read here, at the moment of writing, and never carried on the change:
      // the change list is what backups and plans serialize.
      const value = process.env[secret.valueFrom];
      if (value === undefined) {
        throw new Error(
          `Secret "${secret.name}" reads its value from $${secret.valueFrom}, which is not set. ` +
            'Export it and re-run apply.',
        );
      }
      if (secret.repository && secret.environment) {
        ctx.log(
          `Writing secret ${secret.name} on ${secret.repository} (${secret.environment})`,
        );
        await client.putEnvironmentSecret(
          org,
          secret.repository,
          secret.environment,
          secret.name,
          value,
        );
        return;
      }
      if (secret.repository) {
        ctx.log(`Writing secret ${secret.name} on ${secret.repository}`);
        await client.putRepositorySecret(
          org,
          secret.repository,
          secret.name,
          value,
        );
        return;
      }
      ctx.log(`Writing organization secret ${secret.name}`);
      await client.putOrgSecret(
        org,
        secret.name,
        value,
        requireVisibility(secret.visibility, secret.name),
        secret.selectedRepositories
          ? await ctx.resolveRepositoryIds(secret.selectedRepositories)
          : undefined,
      );
      return;
    }

    case 'delete-secret':
      if (change.repository && change.environment) {
        ctx.log(
          `Deleting secret ${change.name} from ${change.repository} (${change.environment})`,
        );
        await client.deleteEnvironmentSecret(
          org,
          change.repository,
          change.environment,
          change.name,
        );
        return;
      }
      ctx.log(
        change.repository
          ? `Deleting secret ${change.name} from ${change.repository}`
          : `Deleting organization secret ${change.name}`,
      );
      await (change.repository
        ? client.deleteRepositorySecret(org, change.repository, change.name)
        : client.deleteOrgSecret(org, change.name));
      return;

    case 'set-collaborator': {
      const { collaborator, current } = change;
      if (current?.invitationId !== undefined) {
        ctx.log(
          `Updating the invitation of ${collaborator.login} to ${collaborator.repository}`,
        );
        await client.updateRepositoryInvitation(
          org,
          collaborator.repository,
          current.invitationId,
          collaborator.permission,
        );
        return;
      }
      ctx.log(
        `${current ? 'Updating' : 'Adding'} ${collaborator.login} on ${collaborator.repository} as ${collaborator.permission}`,
      );
      await client.putRepositoryCollaborator(
        org,
        collaborator.repository,
        collaborator.login,
        collaborator.permission,
      );
      return;
    }

    case 'remove-collaborator': {
      const { live } = change;
      if (live.invitationId !== undefined) {
        ctx.log(`Withdrawing the invitation of ${live.login} to ${live.repository}`);
        await client.deleteRepositoryInvitation(org, live.repository, live.invitationId);
        return;
      }
      ctx.log(`Removing ${live.login} from ${live.repository}`);
      await client.deleteRepositoryCollaborator(org, live.repository, live.login);
      return;
    }

    case 'put-environment': {
      const { environment, current } = change;
      ctx.log(
        `${current ? 'Updating' : 'Creating'} environment ${environment.name} on ${environment.repository}`,
      );
      // The write replaces the protection rules, so every field the
      // declaration leaves out is sent as it stands on GitHub.
      const reviewers = environment.reviewers ?? current?.reviewers;
      await client.putEnvironment(org, environment.repository, environment.name, {
        deploymentBranchPolicy:
          policyMode(environment.deploymentBranchPolicy) ??
          current?.deploymentBranchPolicy ??
          'all',
        reviewers: [
          ...(await Promise.all(
            (reviewers?.teams ?? []).map(async (slug) => ({
              type: 'Team' as const,
              id: await client.getTeamId(org, ctx.resolveTeamSlug(slug)),
            })),
          )),
          ...(await Promise.all(
            (reviewers?.users ?? []).map(async (login) => ({
              type: 'User' as const,
              id: await client.getUserId(login),
            })),
          )),
        ],
        preventSelfReview:
          environment.preventSelfReview ?? current?.preventSelfReview ?? false,
        waitTimer: environment.waitTimer ?? current?.waitTimer ?? 0,
      });
      for (const policy of change.addPolicies) {
        await client.createEnvironmentBranchPolicy(
          org,
          environment.repository,
          environment.name,
          policy.name,
          policy.type,
        );
      }
      return;
    }

    case 'delete-environment-branch-policy':
      ctx.log(
        `Removing ${change.policy.type} ${change.policy.name} from environment ${change.environment} on ${change.repository}`,
      );
      await client.deleteEnvironmentBranchPolicy(
        org,
        change.repository,
        change.environment,
        change.policy.id,
      );
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

    case 'create-issue-field':
      ctx.log(`Creating issue field "${change.field.name}"`);
      await client.createIssueField(org, change.field);
      return;

    case 'update-issue-field':
      ctx.log(
        `Updating issue field "${change.field.name}" (${fieldNames(change.fields)})`,
      );
      await client.updateIssueField(org, change.live, change.field);
      return;

    case 'delete-issue-field':
      ctx.log(`Deleting issue field "${change.live.name}"`);
      await client.deleteIssueField(org, change.live.id);
      return;

    case 'create-repository': {
      // Unset means "the most open thing that stays inside the company", which
      // is `internal` under an enterprise account and `private` otherwise.
      // Asked outright, it is honoured; `public` is never inferred.
      const visibility =
        change.repository.visibility ??
        ((await client.supportsInternalRepositories(org))
          ? 'internal'
          : 'private');
      ctx.log(`Creating ${visibility} repository "${change.repository.name}"`);
      const repository = await client.createRepository(org, {
        ...change.repository,
        visibility,
      });
      // Grants, attachments and property values later in this run resolve the
      // repository by name, and the cached listing predates this create.
      await ctx.rememberRepositoryId(repository.name, repository.id);
      return;
    }

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
        ? client.assignRoleToTeam(
            org,
            change.roleId,
            ctx.resolveTeamSlug(change.name),
          )
        : client.assignRoleToUser(org, change.roleId, change.name));
      return;

    case 'revoke-org-role':
      ctx.log(
        `Revoking org role "${change.role}" from ${change.subject} ${change.name}`,
      );
      await (change.subject === 'team'
        ? client.removeRoleFromTeam(
            org,
            change.roleId,
            ctx.resolveTeamSlug(change.name),
          )
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

/**
 * The visibility an organization secret or variable must carry. Synthesis
 * guarantees it, so this only fires on a hand-written manifest, where writing
 * with a guessed visibility would decide who reads the value.
 */
function requireVisibility<T>(
  visibility: T | undefined,
  name: string,
): T {
  if (visibility === undefined) {
    throw new Error(
      `Organization secret or variable "${name}" declares no visibility. ` +
        'Say who reads it: "all", "private", or "selected".',
    );
  }
  return visibility;
}
