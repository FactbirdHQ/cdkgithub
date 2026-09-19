import type { LiveTeam } from '../github/client.ts';
import type { DesiredState, TeamManifest } from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';
import { planGovernance } from './plan-governance.ts';
import { planTeamAccess } from './plan-team-access.ts';

/**
 * Diff desired state against the live org and produce an ordered list of changes.
 *
 * Order: team creates (parents before children, as the manifest is already
 * sorted) → team updates → repository grants and rosters → external-group links
 * → team deletes (children before parents) → governance. This lets `apply` run
 * the list top-to-bottom without violating GitHub's parent/child constraints,
 * and puts the governance surfaces after the teams they may name as ruleset
 * bypass actors.
 *
 * Note on membership and access: a team owns neither until it declares one. A
 * team with no `repositories` map keeps the grants it has, and a team with no
 * `members`/`maintainers` keeps its roster, so a definition covering only the
 * team tree still runs on a token that only reaches teams. An IdP-synced team
 * never has its roster diffed whatever it declares, because Entra owns it.
 * Both are written in full when a team is first created, which is the one
 * moment there is nothing live to diff against.
 */
export function plan(desired: DesiredState, live: LiveState): Change[] {
  const liveTeams = live.teams;
  const liveBySlug = new Map(liveTeams.map((t) => [t.slug, t] as const));
  const desiredSlugs = new Set(desired.teams.map((t) => t.slug));

  const creates: Change[] = [];
  const updates: Change[] = [];
  const links: Change[] = [];

  for (const team of desired.teams) {
    const current = liveBySlug.get(team.slug);
    if (!current) {
      creates.push({ kind: 'create', team });
    } else {
      const fields = diffTeam(team, current);
      if (fields.length > 0) {
        updates.push({ kind: 'update', slug: team.slug, team, fields });
      }
    }

    // Linking is idempotent, so we always ensure it for IdP-bound teams.
    if (team.externalGroup) {
      links.push({
        kind: 'link-group',
        slug: team.slug,
        group: team.externalGroup,
      });
    }
  }

  // Deletes: live teams not in the desired state, children before parents.
  const deletes = liveTeams
    .filter((t) => !desiredSlugs.has(t.slug))
    .sort((a, b) => deleteDepth(b, liveTeams) - deleteDepth(a, liveTeams))
    .map<Change>((t) => ({ kind: 'delete', live: t }));

  return [
    ...creates,
    ...updates,
    ...planTeamAccess(desired.teams, live),
    ...links,
    ...deletes,
    ...planGovernance(desired, live),
  ];
}

function diffTeam(desired: TeamManifest, live: LiveTeam): FieldChange[] {
  const fields: FieldChange[] = [];

  const desiredDesc = desired.description ?? '';
  const liveDesc = live.description ?? '';
  if (desiredDesc !== liveDesc) {
    fields.push({ field: 'description', from: liveDesc, to: desiredDesc });
  }

  if (desired.privacy !== live.privacy) {
    fields.push({ field: 'privacy', from: live.privacy, to: desired.privacy });
  }

  const desiredParent = desired.parentSlug ?? null;
  const liveParent = live.parentSlug ?? null;
  if (desiredParent !== liveParent) {
    fields.push({ field: 'parent', from: liveParent, to: desiredParent });
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
