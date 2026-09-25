import type { LiveEnvironment } from '../github/client.ts';
import type { DesiredState, EnvironmentManifest } from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';

type Pattern = { name: string; type: 'branch' | 'tag' };

/**
 * Diff each declared environment. A missing one is created; an existing one
 * has its declared fields brought in line, and nothing else about it changes.
 * No environment is ever deleted: that would take its secrets, variables and
 * deployment history with it, so an undeclared one is left where it is.
 *
 * A `{ branches, tags }` policy is written as GitHub's custom policy plus one
 * pattern per name. Patterns to add ride on the environment write, because a
 * custom policy admits nothing until they exist; a pattern the declaration no
 * longer lists is a gated removal of its own.
 */
export function planEnvironments(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const changes: Change[] = [];
  for (const environment of desired.environments ?? []) {
    const current = live.environments?.find(
      (e) =>
        e.repository === environment.repository && e.name === environment.name,
    );
    const fields = diffEnvironment(environment, current);

    const wanted = patternsOf(environment);
    const existing =
      current?.deploymentBranchPolicy === 'custom' ? current.branchPolicies : [];
    const addPolicies = (wanted ?? []).filter(
      (w) => !existing.some((e) => e.name === w.name && e.type === w.type),
    );
    if (wanted && addPolicies.length > 0) {
      fields.push({
        field: 'patterns',
        from: existing.map(describePattern),
        to: wanted.map(describePattern),
      });
    }

    if (!current || fields.length > 0) {
      changes.push({
        kind: 'put-environment',
        environment,
        current,
        fields,
        addPolicies,
      });
    }

    if (wanted) {
      for (const policy of existing) {
        if (!wanted.some((w) => w.name === policy.name && w.type === policy.type)) {
          changes.push({
            kind: 'delete-environment-branch-policy',
            repository: environment.repository,
            environment: environment.name,
            policy,
          });
        }
      }
    }
  }
  return changes;
}

/** The mode GitHub stores: `all`, `protected`, or `custom` with patterns. */
export function policyMode(
  policy: EnvironmentManifest['deploymentBranchPolicy'],
): 'all' | 'protected' | 'custom' | undefined {
  if (policy === undefined) return undefined;
  return typeof policy === 'string' ? policy : 'custom';
}

function patternsOf(environment: EnvironmentManifest): Pattern[] | undefined {
  const policy = environment.deploymentBranchPolicy;
  if (policy === undefined || typeof policy === 'string') return undefined;
  return [
    ...(policy.branches ?? []).map((name) => ({ name, type: 'branch' as const })),
    ...(policy.tags ?? []).map((name) => ({ name, type: 'tag' as const })),
  ];
}

function describePattern(pattern: Pattern): string {
  return `${pattern.type} ${pattern.name}`;
}

/** Fields the declaration writes that differ from GitHub, or from its defaults when absent. */
function diffEnvironment(
  desired: EnvironmentManifest,
  live: LiveEnvironment | undefined,
): FieldChange[] {
  const fields: FieldChange[] = [];
  const mode = policyMode(desired.deploymentBranchPolicy);
  const liveMode = live?.deploymentBranchPolicy ?? 'all';
  if (mode !== undefined && mode !== liveMode) {
    fields.push({ field: 'deploymentBranchPolicy', from: liveMode, to: mode });
  }

  if (desired.reviewers) {
    const want = reviewerList(desired.reviewers.teams, desired.reviewers.users);
    const have = reviewerList(live?.reviewers.teams, live?.reviewers.users);
    if (want.join() !== have.join()) {
      fields.push({ field: 'reviewers', from: have, to: want });
    }
  }

  const preventSelfReview = live?.preventSelfReview ?? false;
  if (
    desired.preventSelfReview !== undefined &&
    desired.preventSelfReview !== preventSelfReview
  ) {
    fields.push({
      field: 'preventSelfReview',
      from: preventSelfReview,
      to: desired.preventSelfReview,
    });
  }

  const waitTimer = live?.waitTimer ?? 0;
  if (desired.waitTimer !== undefined && desired.waitTimer !== waitTimer) {
    fields.push({ field: 'waitTimer', from: waitTimer, to: desired.waitTimer });
  }
  return fields;
}

function reviewerList(teams: string[] = [], users: string[] = []): string[] {
  return [
    ...teams.map((t) => `team ${t.toLowerCase()}`),
    ...users.map((u) => `user ${u.toLowerCase()}`),
  ].sort();
}
