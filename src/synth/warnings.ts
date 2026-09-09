import type { DesiredState, RulesetManifest } from './manifest.ts';

/**
 * Advisory diagnostics about a desired state, printed by `synth` and again by
 * `plan`. Nothing here blocks anything; these are the judgement calls a reviewer
 * would make reading the definition.
 */
export function collectWarnings(state: DesiredState): string[] {
  return [
    ...warnAboutLegacyBranchProtection(state),
    ...warnAboutOverlappingRulesets(state),
  ];
}

/**
 * An organization has rulesets, which do everything branch protection does and
 * apply across repositories. Reaching for the per-branch API inside an
 * organization usually means someone has not noticed the newer one.
 */
function warnAboutLegacyBranchProtection(state: DesiredState): string[] {
  if (state.ownerType !== 'organization') return [];

  const protections = (state.branchProtection ?? []).filter(
    (p) => p.enabled !== false,
  );
  if (protections.length === 0) return [];

  const branches = protections
    .map((p) => `${p.repository}#${p.branch}`)
    .join(', ');

  return [
    `${protections.length} legacy branch protection${protections.length === 1 ? '' : 's'} declared on an organization: ${branches}. ` +
      'Organization rulesets cover the same rules across every repository at once, including ones nobody has created yet, ' +
      'and a repository-level rule can only add restrictions on top of them. Legacy protection is the right tool for a ' +
      'personal account, or for writing down protection that already exists so it can be migrated. Set `enabled: false` ' +
      'on a BranchProtection to retire it once a Ruleset covers the branch.',
  ];
}

/**
 * Both systems apply at once and the stricter one wins, so a branch covered by
 * each is a branch whose effective policy nobody can read off either
 * declaration.
 */
function warnAboutOverlappingRulesets(state: DesiredState): string[] {
  const branchRulesets = (state.rulesets ?? []).filter(
    (r) => r.target === 'branch' && r.enforcement !== 'disabled',
  );
  if (branchRulesets.length === 0) return [];

  const warnings: string[] = [];
  for (const protection of state.branchProtection ?? []) {
    if (protection.enabled === false) continue;

    const overlapping = branchRulesets.filter((r) =>
      targetsRepository(r, protection.repository),
    );
    if (overlapping.length === 0) continue;

    warnings.push(
      `${protection.repository}#${protection.branch} has legacy branch protection and is also targeted by ruleset${overlapping.length === 1 ? '' : 's'} ` +
        `${overlapping.map((r) => `"${r.name}"`).join(', ')}. GitHub applies both and the stricter rule wins, so the effective ` +
        'policy on that branch is not readable from either declaration alone.',
    );
  }
  return warnings;
}

/**
 * Whether a ruleset's repository condition covers a repository name.
 *
 * Only name targeting is resolved here. A ruleset that selects by custom
 * property depends on values this function cannot see, so it is treated as no
 * match rather than guessed at: a warning that fires on a guess is worse than
 * one that stays quiet.
 */
function targetsRepository(
  ruleset: RulesetManifest,
  repository: string,
): boolean {
  const condition = ruleset.conditions?.repositoryName;
  if (ruleset.conditions?.repositoryProperty) return false;
  // No repository condition at all means every repository in the org.
  if (!condition) return true;

  const matches = (pattern: string) =>
    pattern === '~ALL' || globMatches(pattern, repository);

  if ((condition.exclude ?? []).some(matches)) return false;
  return (condition.include ?? []).some(matches);
}

/** GitHub's repository name patterns, which use `*` as the only wildcard. */
function globMatches(pattern: string, name: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(name);
}
