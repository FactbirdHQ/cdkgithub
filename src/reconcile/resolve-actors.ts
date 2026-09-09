import type { LiveTeam } from '../github/client.ts';
import type {
  ResolvedBypassActor,
  ResolvedRuleset,
  RulesetBypassActor,
  RulesetManifest,
} from '../synth/manifest.ts';
import type { LiveState } from './live.ts';

/**
 * Turn the named bypass actors of a ruleset into the numeric ids GitHub stores.
 *
 * This runs while planning rather than while applying. GitHub returns
 * `actor_id` on every bypass actor, so a definition holding a team slug would
 * never compare equal to the live ruleset and the planner would report drift on
 * every run. Resolving first means the diff sees ids on both sides, and the
 * applier writes what the plan already showed.
 *
 * A name that resolves to nothing throws here, which is the right moment: the
 * plan has not been shown yet and nothing has been written.
 */
export function resolveRuleset(
  ruleset: RulesetManifest,
  live: LiveState,
): ResolvedRuleset {
  const { bypassActors, ...rest } = ruleset;
  if (!bypassActors) return rest;

  return {
    ...rest,
    bypassActors: bypassActors.map((actor) =>
      resolveActor(actor, ruleset.name, live),
    ),
  };
}

function resolveActor(
  actor: RulesetBypassActor,
  rulesetName: string,
  live: LiveState,
): ResolvedBypassActor {
  const bypassMode = actor.bypassMode;

  switch (actor.actorType) {
    case 'OrganizationAdmin':
      // GitHub's own description pins this one: for OrganizationAdmin the id is 1.
      return { actorType: 'OrganizationAdmin', actorId: 1, bypassMode };

    case 'DeployKey':
      return { actorType: 'DeployKey', actorId: null, bypassMode };

    case 'RepositoryRole':
      return {
        actorType: 'RepositoryRole',
        actorId: actor.roleId,
        bypassMode,
      };

    case 'Team':
      return {
        actorType: 'Team',
        actorId:
          typeof actor.team === 'number'
            ? actor.team
            : resolveTeam(actor.team, rulesetName, live.teams),
        bypassMode,
      };

    case 'Integration':
      return {
        actorType: 'Integration',
        actorId:
          typeof actor.app === 'number'
            ? actor.app
            : resolveApp(actor.app, rulesetName, live),
        bypassMode,
      };
  }
}

function resolveTeam(
  slug: string,
  rulesetName: string,
  teams: LiveTeam[],
): number {
  const team = teams.find((t) => t.slug === slug);
  if (!team) {
    throw new Error(
      `Ruleset "${rulesetName}" lets team "${slug}" bypass it, but the organization has no such team. ` +
        `A team this definition creates can be a bypass actor, but only once it exists: apply the team first, then the ruleset.`,
    );
  }
  return team.id;
}

function resolveApp(
  slug: string,
  rulesetName: string,
  live: LiveState,
): number {
  const installation = (live.appInstallations ?? []).find(
    (i) => i.slug === slug,
  );
  if (!installation) {
    throw new Error(
      `Ruleset "${rulesetName}" lets app "${slug}" bypass it, but no app with that slug is installed on the organization.`,
    );
  }
  return installation.appId;
}
