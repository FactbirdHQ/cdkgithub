import type { LiveRepositoryRuleset } from '../github/client.ts';
import type { DesiredState } from '../synth/manifest.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';
import { diffRuleset } from './plan-governance.ts';
import { resolveRuleset } from './resolve-actors.ts';

/**
 * Diff the rulesets of every repository the definition declares one on.
 *
 * Ownership is per repository: declaring a ruleset on `flight-deck` owns
 * `flight-deck`'s rulesets, so a live one missing from the definition becomes a
 * delete there, while every undeclared repository keeps its rulesets unread and
 * untouched. Only what the repository itself defines is compared; org and
 * enterprise rulesets are visible from the repository but owned elsewhere, and
 * the live read leaves them out.
 */
export function planRepositoryRulesets(
  desired: DesiredState,
  live: LiveState,
): Change[] {
  const declared = desired.repositoryRulesets;
  if (!declared) return [];

  const liveByRepo = new Map<string, LiveRepositoryRuleset[]>();
  for (const ruleset of live.repositoryRulesets ?? []) {
    const existing = liveByRepo.get(ruleset.repository) ?? [];
    existing.push(ruleset);
    liveByRepo.set(ruleset.repository, existing);
  }

  const changes: Change[] = [];
  for (const repository of [...new Set(declared.map((r) => r.repository))]) {
    const wanted = declared.filter((r) => r.repository === repository);
    const current = liveByRepo.get(repository) ?? [];
    const currentByName = new Map(current.map((r) => [r.name, r]));

    for (const { repository: _repository, ...manifest } of wanted) {
      // Bypass actors resolve against the same live org as the org rulesets,
      // and an app must also be installed on this repository.
      const ruleset = resolveRuleset(manifest, live, repository);
      const existing = currentByName.get(ruleset.name);
      if (!existing) {
        changes.push({ kind: 'create-repo-ruleset', repository, ruleset });
        continue;
      }
      const fields = diffRuleset(ruleset, existing);
      if (fields.length > 0) {
        changes.push({
          kind: 'update-repo-ruleset',
          repository,
          id: existing.id,
          ruleset,
          fields,
        });
      }
    }

    const names = new Set(wanted.map((r) => r.name));
    for (const liveRuleset of current) {
      if (!names.has(liveRuleset.name)) {
        changes.push({
          kind: 'delete-repo-ruleset',
          repository,
          live: liveRuleset,
        });
      }
    }
  }

  return changes;
}
