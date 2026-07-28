import type { LiveTeam } from "../github/client.ts";
import type { DesiredState, TeamManifest } from "../synth/manifest.ts";
import type { Change, FieldChange } from "./changes.ts";

/**
 * Diff desired state against the live org and produce an ordered list of changes.
 *
 * Order: creates (parents before children, as the manifest is already sorted) →
 * updates → external-group links → deletes (children before parents). This lets
 * `apply` run the list top-to-bottom without violating GitHub's parent/child
 * constraints.
 *
 * Note on membership: for existing teams we do NOT diff members or repo grants —
 * IdP-synced teams have their membership owned by Entra ID (SCIM). The `members`
 * / `repositories` fields are applied best-effort when a team is first created.
 */
export function plan(desired: DesiredState, live: LiveTeam[]): Change[] {
  const liveBySlug = new Map(live.map((t) => [t.slug, t] as const));
  const desiredSlugs = new Set(desired.teams.map((t) => t.slug));

  const creates: Change[] = [];
  const updates: Change[] = [];
  const links: Change[] = [];

  for (const team of desired.teams) {
    const current = liveBySlug.get(team.slug);
    if (!current) {
      creates.push({ kind: "create", team });
    } else {
      const fields = diffTeam(team, current);
      if (fields.length > 0) {
        updates.push({ kind: "update", slug: team.slug, team, fields });
      }
    }

    // Linking is idempotent, so we always ensure it for IdP-bound teams.
    if (team.externalGroup) {
      links.push({ kind: "link-group", slug: team.slug, group: team.externalGroup });
    }
  }

  // Deletes: live teams not in the desired state, children before parents.
  const deletes = live
    .filter((t) => !desiredSlugs.has(t.slug))
    .sort((a, b) => deleteDepth(b, live) - deleteDepth(a, live))
    .map<Change>((t) => ({ kind: "delete", live: t }));

  return [...creates, ...updates, ...links, ...deletes];
}

function diffTeam(desired: TeamManifest, live: LiveTeam): FieldChange[] {
  const fields: FieldChange[] = [];

  const desiredDesc = desired.description ?? "";
  const liveDesc = live.description ?? "";
  if (desiredDesc !== liveDesc) {
    fields.push({ field: "description", from: liveDesc, to: desiredDesc });
  }

  if (desired.privacy !== live.privacy) {
    fields.push({ field: "privacy", from: live.privacy, to: desired.privacy });
  }

  const desiredParent = desired.parentSlug ?? null;
  const liveParent = live.parentSlug ?? null;
  if (desiredParent !== liveParent) {
    fields.push({ field: "parent", from: liveParent, to: desiredParent });
  }

  return fields;
}

/** Depth of a live team in its parent chain (deeper = delete first). */
function deleteDepth(team: LiveTeam, all: LiveTeam[]): number {
  const bySlug = new Map(all.map((t) => [t.slug, t] as const));
  let depth = 0;
  let current: LiveTeam | undefined = team;
  while (current?.parentSlug) {
    depth++;
    current = bySlug.get(current.parentSlug);
    if (depth > all.length) break; // cycle guard
  }
  return depth;
}
