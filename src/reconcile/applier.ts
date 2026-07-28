import type { GitHubClient, LiveTeam } from "../github/client.ts";
import type { Change } from "./changes.ts";

export interface ApplyOptions {
  /** Actually delete teams present on GitHub but absent from the desired state. */
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
  live: LiveTeam[],
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const log = options.onProgress ?? (() => {});
  const idBySlug = new Map<string, number>(live.map((t) => [t.slug, t.id]));

  let created = 0;
  let updated = 0;
  let deleted = 0;
  let linked = 0;
  const skipped: string[] = [];

  for (const change of changes) {
    switch (change.kind) {
      case "create": {
        const t = change.team;
        log(`Creating team ${t.slug}`);
        const parentTeamId = t.parentSlug ? idBySlug.get(t.parentSlug) : undefined;
        const team = await client.createTeam(org, {
          name: t.name,
          description: t.description,
          privacy: t.privacy,
          parentTeamId,
        });
        idBySlug.set(team.slug, team.id);

        // Best-effort membership & repo grants on creation (see planner notes).
        for (const username of t.maintainers) {
          await client.setMembership(org, team.slug, username, "maintainer");
        }
        for (const username of t.members) {
          await client.setMembership(org, team.slug, username, "member");
        }
        for (const [repo, permission] of Object.entries(t.repositories)) {
          await client.setRepoPermission(org, team.slug, repo, permission);
        }
        created++;
        break;
      }

      case "update": {
        log(`Updating team ${change.slug}`);
        const parentSlug = change.team.parentSlug;
        await client.updateTeam(org, change.slug, {
          name: change.team.name,
          description: change.team.description ?? "",
          privacy: change.team.privacy,
          parentTeamId: parentSlug ? (idBySlug.get(parentSlug) ?? null) : null,
        });
        updated++;
        break;
      }

      case "link-group": {
        if (!options.enableScim) {
          const ref = change.group.id ?? change.group.name;
          skipped.push(`link ${change.slug} → Entra group ${ref} (use --enable-scim)`);
          break;
        }
        log(`Linking team ${change.slug} to Entra group`);
        const groupId = await resolveGroupId(client, org, change);
        await client.linkExternalGroup(org, change.slug, groupId);
        linked++;
        break;
      }

      case "delete": {
        if (!options.allowDelete) {
          skipped.push(`delete ${change.live.slug} (use --allow-delete)`);
          break;
        }
        log(`Deleting team ${change.live.slug}`);
        await client.deleteTeam(org, change.live.slug);
        deleted++;
        break;
      }
    }
  }

  return { created, updated, deleted, linked, skipped };
}

async function resolveGroupId(
  client: GitHubClient,
  org: string,
  change: Extract<Change, { kind: "link-group" }>,
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
