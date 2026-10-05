import type { LiveTeam } from '../github/client.ts';
import type { ResolvedBypassActor, ResolvedRuleset, RulesetBypassActor, RulesetManifest } from '../synth/manifest.ts';
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
 * plan has not been shown yet and nothing has been written. So does an app
 * bypass on a repository ruleset whose installation does not cover that
 * repository, which GitHub would otherwise reject mid-apply.
 *
 * `repository` is the repository a repository ruleset lives on, and is
 * absent for an organization ruleset.
 */
export function resolveRuleset(ruleset: RulesetManifest, live: LiveState, repository?: string): ResolvedRuleset {
  const { bypassActors, ...rest } = ruleset;
  if (!bypassActors) {
    return rest;
  }

  return {
    ...rest,
    bypassActors: bypassActors.map((actor) => {
      if (actor.actorType === 'Integration' && repository !== undefined) {
        assertAppCovers(actor.app, ruleset.name, repository, live);
      }
      return resolveActor(actor, ruleset.name, live);
    }),
  };
}

/**
 * Throw when the app's installation provably leaves `repository` out. An
 * installation this token cannot list is let through, and GitHub decides.
 */
function assertAppCovers(app: string | number, rulesetName: string, repository: string, live: LiveState): void {
  const installation = (live.appInstallations ?? []).find((i) =>
    typeof app === 'number' ? i.appId === app : i.slug === app,
  );
  if (
    installation?.repositorySelection !== 'selected' ||
    installation.repositories === undefined ||
    installation.repositories.includes(repository)
  ) {
    return;
  }
  throw new Error(
    `Ruleset "${rulesetName}" on repository "${repository}" lets app "${installation.slug}" bypass it, but the app is not installed on "${repository}". ` +
      `GitHub only accepts an app that can see the repository: add "${repository}" to the app's installation, or drop the bypass actor.`,
  );
}

function resolveActor(actor: RulesetBypassActor, rulesetName: string, live: LiveState): ResolvedBypassActor {
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
        actorId: typeof actor.team === 'number' ? actor.team : resolveTeam(actor.team, rulesetName, live.teams),
        bypassMode,
      };

    case 'Integration':
      return {
        actorType: 'Integration',
        actorId: typeof actor.app === 'number' ? actor.app : resolveApp(actor.app, rulesetName, live),
        bypassMode,
      };
  }
}

function resolveTeam(slug: string, rulesetName: string, teams: LiveTeam[]): number {
  const team = teams.find((t) => t.slug === slug);
  if (!team) {
    throw new Error(
      `Ruleset "${rulesetName}" lets team "${slug}" bypass it, but the organization has no such team. ` +
        `A team this definition creates can be a bypass actor, but only once it exists: apply the team first, then the ruleset.`,
    );
  }
  return team.id;
}

function resolveApp(slug: string, rulesetName: string, live: LiveState): number {
  const installation = (live.appInstallations ?? []).find((i) => i.slug === slug);
  if (!installation) {
    throw new Error(
      `Ruleset "${rulesetName}" lets app "${slug}" bypass it, but no app with that slug is installed on the organization.`,
    );
  }
  return installation.appId;
}
