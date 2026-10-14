import type { RepositoryManifest, RepositoryMergeSettings } from '../synth/manifest.ts';
import { REPOSITORY_MERGE_SETTINGS } from '../synth/manifest.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';
import { diffDeclared } from './plan-governance.ts';

/**
 * Create the declared repositories GitHub does not have yet, and hold the ones
 * it has to their declared merge settings.
 *
 * A declaration removed from the definition removes the declaration, never the
 * repository. Creating a repository by mistake is undone in ten seconds;
 * deleting one is not undone at all, and the edit that drops a repository from
 * a definition looks exactly like the edit that drops it from the company.
 *
 * On an existing repository only the merge settings are compared, and only the
 * ones declared. Visibility in particular never is: its unset default is the
 * most closed thing that still works, which is right for a repository that does
 * not exist and wrong for one that does. Applied to a live repository it would
 * quietly close an open one, and a declaration saying `public` would quietly
 * open a closed one. Merge settings change how a pull request lands, never who
 * can see the repository, so they carry no such risk.
 *
 * An archived repository is read-only, so it is left as it stands.
 */
export function planRepositories(desired: RepositoryManifest[] | undefined, live: LiveState): Change[] {
  if (!desired) {
    return [];
  }
  // Matched case-insensitively: GitHub treats `Netcore` and `netcore` as the same
  // repository and would answer a create for the second with a 422.
  const existing = new Set((live.repositories ?? []).map((r) => r.name.toLowerCase()));
  const liveSettings = new Map((live.repositoryMergeSettings ?? []).map((s) => [s.repository.toLowerCase(), s]));

  return desired.flatMap((repository): Change[] => {
    if (!existing.has(repository.name.toLowerCase())) {
      return [{ kind: 'create-repository', repository }];
    }
    const current = liveSettings.get(repository.name.toLowerCase());
    if (!current || current.archived) {
      return [];
    }
    const settings = mergeSettingsOf(repository);
    const fields = diffDeclared(settings, current);
    return fields.length === 0
      ? []
      : [{ kind: 'repository-merge-settings', repository: current.repository, settings, fields }];
  });
}

function mergeSettingsOf(repository: RepositoryManifest): RepositoryMergeSettings {
  return Object.fromEntries(
    REPOSITORY_MERGE_SETTINGS.filter((key) => repository[key] !== undefined).map((key) => [key, repository[key]]),
  );
}
