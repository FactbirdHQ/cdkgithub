import type { GitHubClient } from '../github/client.ts';
import {
  applyGovernanceChange,
  type GovernanceContext,
} from './apply-governance.ts';
import {
  type Change,
  type DestructiveKind,
  isDestructive,
  isGovernanceChange,
} from './changes.ts';
import type { LiveState } from './live.ts';

export interface ApplyOptions {
  /**
   * Actually delete resources present on GitHub but absent from the desired
   * state. `true` permits every destructive kind; a set permits only those
   * kinds, so a run pruning teams need not also authorize revoking roles.
   */
  readonly allowDelete?: boolean | ReadonlySet<DestructiveKind>;
  /**
   * Perform Entra ID (SCIM) external-group linking. Requires the org to have SCIM
   * provisioning enabled. When false, link changes are skipped and reported.
   */
  readonly enableScim?: boolean;
  /** Called with a one-line description before each executed change. */
  readonly onProgress?: (message: string) => void;
  /**
   * Called after each change is attempted, in order: the journal a partial
   * apply leaves behind. A failed change is reported and then rethrown, so the
   * last record of an aborted run names what broke.
   */
  readonly onRecord?: (record: ApplyRecord) => void;
}

/** One journal entry: what was attempted and how it ended. */
export interface ApplyRecord {
  readonly kind: Change['kind'];
  readonly description: string;
  readonly status: 'applied' | 'failed' | 'skipped';
  readonly error?: string;
}

export interface ApplyResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly linked: number;
  /** Governance changes executed: settings, policy, rulesets, configurations, properties. */
  readonly governance: number;
  /** Human-readable descriptions of changes intentionally skipped (gated). */
  readonly skipped: string[];
}

/** Whether the gate lets this change through. */
export function deleteAllowed(
  change: Change,
  allowDelete: ApplyOptions['allowDelete'],
): boolean {
  if (!isDestructive(change)) return true;
  if (allowDelete === true) return true;
  if (!allowDelete) return false;
  return allowDelete.has(change.kind as DestructiveKind);
}

/**
 * Execute a plan against GitHub. Assumes `changes` are ordered
 * (parents-before-children for creates, children-first for deletes) as produced
 * by {@link plan}.
 */
export async function apply(
  client: GitHubClient,
  org: string,
  changes: Change[],
  live: LiveState,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const log = options.onProgress ?? (() => {});
  const record = options.onRecord ?? (() => {});
  const idBySlug = new Map<string, number>(
    live.teams.map((t) => [t.slug, t.id]),
  );
  // A rename keeps the team's id, so the new slug can be resolved before the
  // PATCH that creates it. Without this, a team nested under one being renamed
  // would look up a parent that does not exist yet and be created top-level.
  for (const change of changes) {
    if (change.kind !== 'update' || change.team.slug === change.slug) continue;
    const id = idBySlug.get(change.slug);
    if (id !== undefined) idBySlug.set(change.team.slug, id);
  }
  // Planned slug to the slug GitHub actually derived, filled in as renames
  // land. GitHub owns slug derivation; when it disagrees with the local guess,
  // every later change addressed to the guess would target a team that does
  // not exist.
  const aliases = new Map<string, string>();
  const slugOf = (declared: string) => aliases.get(declared) ?? declared;
  const governanceContext = createGovernanceContext(client, org, log, slugOf);

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let linked = 0;
  let governance = 0;
  const skipped: string[] = [];

  for (const change of changes) {
    if (!deleteAllowed(change, options.allowDelete)) {
      skipped.push(`${describeDelete(change)} (use --allow-delete)`);
      record({
        kind: change.kind,
        description: describeDelete(change),
        status: 'skipped',
      });
      continue;
    }
    if (change.kind === 'link-group' && !options.enableScim) {
      const ref = change.group.id ?? change.group.name;
      const description = `link ${change.slug} → Entra group ${ref}`;
      skipped.push(`${description} (use --enable-scim)`);
      record({ kind: change.kind, description, status: 'skipped' });
      continue;
    }

    try {
      if (isGovernanceChange(change)) {
        await applyGovernanceChange(change, governanceContext);
        governance++;
      } else {
        switch (change.kind) {
          case 'create': {
            const t = change.team;
            log(`Creating team ${t.slug}`);
            const parentTeamId = t.parentSlug
              ? idBySlug.get(t.parentSlug)
              : undefined;
            const team = await client.createTeam(org, {
              name: t.name,
              description: t.description,
              privacy: t.privacy,
              parentTeamId,
            });
            idBySlug.set(team.slug, team.id);
            if (team.slug !== t.slug) aliases.set(t.slug, team.slug);

            // Written in full here: a team that has just been created has no live
            // roster or grants to diff, so the planner has nothing to say about it.
            for (const username of t.maintainers ?? []) {
              await client.setMembership(org, team.slug, username, 'maintainer');
            }
            for (const username of t.members ?? []) {
              await client.setMembership(org, team.slug, username, 'member');
            }
            for (const [repo, permission] of Object.entries(
              t.repositories ?? {},
            )) {
              await client.setRepoPermission(org, team.slug, repo, permission);
            }
            created++;
            break;
          }

          case 'update': {
            const renamed = change.team.slug !== change.slug;
            log(
              renamed
                ? `Renaming team ${change.slug} to ${change.team.slug}`
                : `Updating team ${change.slug}`,
            );
            const parentSlug = change.team.parentSlug;
            // Addressed by the live slug. GitHub derives the new one from the
            // name and stops answering to the old one; the response says which
            // slug it actually derived, and that answer, not the local guess,
            // is what the rest of this run must address.
            const team = await client.updateTeam(org, change.slug, {
              name: change.team.name,
              description: change.team.description ?? '',
              privacy: change.team.privacy,
              parentTeamId: parentSlug
                ? (idBySlug.get(parentSlug) ?? null)
                : null,
            });
            idBySlug.set(team.slug, team.id);
            if (team.slug !== change.team.slug) {
              aliases.set(change.team.slug, team.slug);
              log(
                `Note: GitHub derived slug ${team.slug}, not ${change.team.slug}; ` +
                  'addressing the rest of this run to it',
              );
            }
            updated++;
            break;
          }

          case 'set-repo-access': {
            log(
              `Granting ${change.slug} ${change.permission} on ${change.repository}`,
            );
            await client.setRepoPermission(
              org,
              slugOf(change.slug),
              change.repository,
              change.permission,
            );
            updated++;
            break;
          }

          case 'remove-repo-access': {
            log(`Removing ${change.slug} from ${change.repository}`);
            await client.removeRepoPermission(
              org,
              slugOf(change.slug),
              change.repository,
            );
            deleted++;
            break;
          }

          case 'set-membership': {
            log(`Adding ${change.username} to ${change.slug} as ${change.role}`);
            await client.setMembership(
              org,
              slugOf(change.slug),
              change.username,
              change.role,
            );
            updated++;
            break;
          }

          case 'remove-membership': {
            log(`Removing ${change.username} from ${change.slug}`);
            await client.removeMembership(
              org,
              slugOf(change.slug),
              change.username,
            );
            deleted++;
            break;
          }

          case 'link-group': {
            log(`Linking team ${change.slug} to Entra group`);
            const groupId = await resolveGroupId(client, org, change);
            await client.linkExternalGroup(org, slugOf(change.slug), groupId);
            linked++;
            break;
          }

          case 'delete': {
            log(`Deleting team ${change.live.slug}`);
            await client.deleteTeam(org, change.live.slug);
            deleted++;
            break;
          }
        }
      }
      record({
        kind: change.kind,
        description: describeChange(change),
        status: 'applied',
      });
    } catch (error) {
      record({
        kind: change.kind,
        description: describeChange(change),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  return { created, updated, deleted, linked, governance, skipped };
}

/**
 * Lazy lookups shared by the governance changes: the org's repositories, and the
 * code security configurations including any created earlier in this same run.
 */
function createGovernanceContext(
  client: GitHubClient,
  org: string,
  log: (message: string) => void,
  resolveTeamSlug: (declared: string) => string,
): GovernanceContext {
  let repositoryIds: Promise<Map<string, number>> | undefined;
  const configurationIds = new Map<string, number>();

  return {
    client,
    org,
    log,
    resolveTeamSlug,

    async resolveRepositoryIds(names) {
      repositoryIds ??= client
        .listRepositories(org)
        .then((repos) => new Map(repos.map((r) => [r.name, r.id])));
      const byName = await repositoryIds;
      return names.map((name) => {
        const id = byName.get(name);
        if (id === undefined) {
          throw new Error(
            `Repository "${name}" was not found in the ${org} organization.`,
          );
        }
        return id;
      });
    },

    async rememberRepositoryId(name, id) {
      // A repository created this run joins the cached map, so a grant or an
      // attachment later in the same run can name it.
      if (repositoryIds) (await repositoryIds).set(name, id);
      else repositoryIds = Promise.resolve(new Map([[name, id]]));
    },

    rememberConfigurationId(name, id) {
      configurationIds.set(name, id);
    },

    async resolveConfigurationId(name) {
      // A configuration created earlier in this run is already known. Anything
      // else is looked up live rather than from the pre-apply snapshot, and the
      // lookup repeats on a miss because this run keeps creating configurations
      // as it goes.
      const known = configurationIds.get(name);
      if (known !== undefined) return known;

      for (const config of await client.listSecurityConfigurations(org)) {
        configurationIds.set(config.name, config.id);
      }

      const id = configurationIds.get(name);
      if (id === undefined) {
        throw new Error(
          `Code security configuration "${name}" was not found in the ${org} organization.`,
        );
      }
      return id;
    },
  };
}

/** A one-line identity for a change, for the journal and the skip report. */
export function describeChange(change: Change): string {
  if (isDestructive(change)) return describeDelete(change);
  switch (change.kind) {
    case 'create':
      return `create team ${change.team.slug}`;
    case 'update':
      return `update team ${change.slug}`;
    case 'set-repo-access':
      return `grant ${change.slug} ${change.permission} on ${change.repository}`;
    case 'set-membership':
      return `add ${change.username} to ${change.slug} as ${change.role}`;
    case 'link-group':
      return `link ${change.slug} to Entra group ${change.group.id ?? change.group.name}`;
    case 'org-settings':
      return 'update organization settings';
    case 'actions-policy':
      return 'update the Actions policy';
    case 'create-ruleset':
      return `create ruleset "${change.ruleset.name}"`;
    case 'update-ruleset':
      return `update ruleset "${change.ruleset.name}"`;
    case 'create-security-config':
      return `create code security configuration "${change.config.name}"`;
    case 'update-security-config':
      return `update code security configuration "${change.config.name}"`;
    case 'default-security-config':
      return `default "${change.configName}" for ${change.scope} new repositories`;
    case 'attach-security-config':
      return `attach "${change.configName}" to ${change.scope} repositories`;
    case 'create-property':
      return `create custom property "${change.property.name}"`;
    case 'update-property':
      return `update custom property "${change.property.name}"`;
    case 'property-values':
      return `set custom property "${change.propertyName}" values`;
    case 'branch-protection':
      return `protect ${change.protection.repository}#${change.protection.branch}`;
    case 'create-repository':
      return `create repository "${change.repository.name}"`;
    case 'create-repo-role':
      return `create repository role "${change.role.name}"`;
    case 'update-repo-role':
      return `update repository role "${change.role.name}"`;
    case 'assign-org-role':
      return `grant org role "${change.role}" to ${change.subject} ${change.name}`;
    default:
      return change.kind;
  }
}

function describeDelete(change: Change): string {
  switch (change.kind) {
    case 'delete':
      return `delete team ${change.live.slug}`;
    case 'remove-repo-access':
      return `remove ${change.slug}'s ${change.from} on ${change.repository}`;
    case 'remove-membership':
      return `remove ${change.username} from ${change.slug}`;
    case 'delete-ruleset':
      return `delete ruleset "${change.live.name}"`;
    case 'delete-security-config':
      return `delete code security configuration "${change.live.name}"`;
    case 'delete-property':
      return `delete custom property "${change.live.name}"`;
    case 'revoke-org-role':
      return `revoke org role "${change.role}" from ${change.subject} ${change.name}`;
    case 'delete-repo-role':
      return `delete repository role "${change.live.name}"`;
    case 'remove-branch-protection':
      return `remove branch protection from ${change.repository}#${change.branch}`;
    default:
      return `delete ${change.kind}`;
  }
}

async function resolveGroupId(
  client: GitHubClient,
  org: string,
  change: Extract<Change, { kind: 'link-group' }>,
): Promise<number> {
  if (change.group.id !== undefined) return change.group.id;

  const groups = await client.listExternalGroups(org);
  const match = groups.find((g) => g.name === change.group.name);
  if (!match) {
    throw new Error(
      `Entra group "${change.group.name}" not found among the org's external groups. ` +
        `Ensure it is provisioned via SCIM before linking team ${change.slug}.`,
    );
  }
  return match.id;
}
