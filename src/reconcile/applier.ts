import type { GitHubClient } from '../github/client.ts';
import {
  applyGovernanceChange,
  type GovernanceContext,
} from './apply-governance.ts';
import { type Change, isDestructive, isGovernanceChange } from './changes.ts';
import type { LiveState } from './live.ts';

export interface ApplyOptions {
  /**
   * Actually delete resources present on GitHub but absent from the desired
   * state — teams, rulesets, code security configurations, custom properties.
   */
  readonly allowDelete?: boolean;
  /**
   * Perform Entra ID (SCIM) external-group linking. Requires the org to have SCIM
   * provisioning enabled. When false, link changes are skipped and reported.
   */
  readonly enableScim?: boolean;
  /** Called with a one-line description before each executed change. */
  readonly onProgress?: (message: string) => void;
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
  const idBySlug = new Map<string, number>(
    live.teams.map((t) => [t.slug, t.id]),
  );
  const governanceContext = createGovernanceContext(client, org, log);

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let linked = 0;
  let governance = 0;
  const skipped: string[] = [];

  for (const change of changes) {
    if (isDestructive(change) && !options.allowDelete) {
      skipped.push(`${describeDelete(change)} (use --allow-delete)`);
      continue;
    }

    if (isGovernanceChange(change)) {
      await applyGovernanceChange(change, governanceContext);
      governance++;
      continue;
    }

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

        // Written in full here: a team that has just been created has no live
        // roster or grants to diff, so the planner has nothing to say about it.
        for (const username of t.maintainers ?? []) {
          await client.setMembership(org, team.slug, username, 'maintainer');
        }
        for (const username of t.members ?? []) {
          await client.setMembership(org, team.slug, username, 'member');
        }
        for (const [repo, permission] of Object.entries(t.repositories ?? {})) {
          await client.setRepoPermission(org, team.slug, repo, permission);
        }
        created++;
        break;
      }

      case 'update': {
        log(`Updating team ${change.slug}`);
        const parentSlug = change.team.parentSlug;
        await client.updateTeam(org, change.slug, {
          name: change.team.name,
          description: change.team.description ?? '',
          privacy: change.team.privacy,
          parentTeamId: parentSlug ? (idBySlug.get(parentSlug) ?? null) : null,
        });
        updated++;
        break;
      }

      case 'set-repo-access': {
        log(
          `Granting ${change.slug} ${change.permission} on ${change.repository}`,
        );
        await client.setRepoPermission(
          org,
          change.slug,
          change.repository,
          change.permission,
        );
        updated++;
        break;
      }

      case 'remove-repo-access': {
        log(`Removing ${change.slug} from ${change.repository}`);
        await client.removeRepoPermission(org, change.slug, change.repository);
        deleted++;
        break;
      }

      case 'set-membership': {
        log(`Adding ${change.username} to ${change.slug} as ${change.role}`);
        await client.setMembership(
          org,
          change.slug,
          change.username,
          change.role,
        );
        updated++;
        break;
      }

      case 'remove-membership': {
        log(`Removing ${change.username} from ${change.slug}`);
        await client.removeMembership(org, change.slug, change.username);
        deleted++;
        break;
      }

      case 'link-group': {
        if (!options.enableScim) {
          const ref = change.group.id ?? change.group.name;
          skipped.push(
            `link ${change.slug} → Entra group ${ref} (use --enable-scim)`,
          );
          break;
        }
        log(`Linking team ${change.slug} to Entra group`);
        const groupId = await resolveGroupId(client, org, change);
        await client.linkExternalGroup(org, change.slug, groupId);
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
): GovernanceContext {
  let repositoryIds: Promise<Map<string, number>> | undefined;
  const configurationIds = new Map<string, number>();

  return {
    client,
    org,
    log,

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
