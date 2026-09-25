import type { LiveTeam } from '../github/client.ts';
import type { DesiredState, TeamManifest } from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import { isDestructive } from './changes.ts';
import type { LiveState } from './live.ts';
import { resolveLive } from './live.ts';
import { planActionsAdmin } from './plan-actions-admin.ts';
import { planCustomRepositoryRoles } from './plan-custom-roles.ts';
import { planRepositories } from './plan-repositories.ts';
import { planGovernance } from './plan-governance.ts';
import { planOrganizationRoles } from './plan-org-roles.ts';
import { planRepositoryRulesets } from './plan-repo-rulesets.ts';
import { planTeamAccess } from './plan-team-access.ts';

/**
 * Diff desired state against the live org and produce an ordered list of changes.
 *
 * Order: team creates (parents before children, as the manifest is already
 * sorted) → team updates → repository creates and custom repository roles →
 * repository grants and rosters → external-group links → team deletes
 * (children before parents) → governance. This lets `apply` run the list
 * top-to-bottom without violating GitHub's parent/child constraints, puts a
 * repository and a custom role before the grants that name them, and puts the
 * governance surfaces after the teams they may name as ruleset bypass actors.
 *
 * Every removal then moves behind every addition, keeping the order above
 * within each half. A removal is often retiring what an addition replaces:
 * legacy branch protection once a ruleset covers the branch, an old team once
 * its successor holds the grants, an old ruleset once the new one is active.
 * `apply` stops at the first failure, so with removals last a failed addition
 * leaves the old control standing rather than a gap where both are missing.
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
  // A live team claimed through a rename marker is not an orphan, so it must not
  // fall into the deletes below.
  const claimed = new Set(
    desired.teams.map((t) => resolveLive(t, liveBySlug)?.slug ?? t.slug),
  );

  const creates: Change[] = [];
  const updates: Change[] = [];
  const links: Change[] = [];

  for (const team of desired.teams) {
    const current = resolveLive(team, liveBySlug);
    if (!current) {
      creates.push({ kind: 'create', team });
    } else {
      const fields = diffTeam(team, current);
      if (fields.length > 0) {
        // Addressed by the slug GitHub answers to now. A rename is a PATCH on
        // the old slug that leaves the new one in place.
        updates.push({ kind: 'update', slug: current.slug, team, fields });
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
    .filter((t) => !claimed.has(t.slug))
    .sort((a, b) => deleteDepth(b, liveTeams) - deleteDepth(a, liveTeams))
    .map<Change>((t) => ({ kind: 'delete', live: t }));

  // Custom-role creates and updates run before the grants that name them; the
  // deletes run after the grants have been removed, since a role still granted
  // through is not deletable.
  const roleChanges = planCustomRepositoryRoles(
    desired.customRepositoryRoles,
    live,
  );
  const roleUpserts = roleChanges.filter((c) => c.kind !== 'delete-repo-role');
  const roleDeletes = roleChanges.filter((c) => c.kind === 'delete-repo-role');

  const ordered = [
    ...creates,
    ...updates,
    // Before the team access below and the governance further down: a grant, a
    // branch protection, or a property value may name a repository or a custom
    // role this same run creates.
    ...planRepositories(desired.repositories, live),
    ...roleUpserts,
    ...planTeamAccess(desired.teams, live),
    ...links,
    ...deletes,
    ...planGovernance(desired, live),
    // After the repository creates above, so a ruleset, a variable, or a
    // secret declared on a repository this run creates lands on it.
    ...planRepositoryRulesets(desired, live),
    ...planActionsAdmin(desired, live),
    ...roleDeletes,
    ...planOrganizationRoles(desired.organizationRoles, live),
  ];
  return [
    ...ordered.filter((change) => !isDestructive(change)),
    ...ordered.filter(isDestructive),
  ];
}

function diffTeam(desired: TeamManifest, live: LiveTeam): FieldChange[] {
  const fields: FieldChange[] = [];

  // The slug is the consequence GitHub derives, so it is what the plan shows.
  // The name comes along with it, and on its own when a rename leaves the slug
  // untouched, as capitalisation and punctuation do.
  if (desired.slug !== live.slug) {
    fields.push({ field: 'slug', from: live.slug, to: desired.slug });
  }
  if (desired.name !== live.name) {
    fields.push({ field: 'name', from: live.name, to: desired.name });
  }

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
