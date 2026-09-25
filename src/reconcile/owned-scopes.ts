import type { OwnedScopes } from '../synth/manifest.ts';

/** Every scope a secret or variable collection owns, resolved. */
export interface Scopes {
  readonly organization: boolean;
  readonly repositories: string[];
}

/**
 * The scopes the entries name, plus the ones declared owned without an entry.
 * Repositories keep the order the entries name them in, then the owned-only
 * ones, so a plan lists changes in the order the definition reads.
 */
export function scopesOf(
  entries: ReadonlyArray<{ repository?: string }> | undefined,
  owned: OwnedScopes | undefined,
): Scopes {
  const repositories = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry.repository) repositories.add(entry.repository);
  }
  for (const repository of owned?.repositories ?? []) {
    repositories.add(repository);
  }
  return {
    organization:
      owned?.organization === true ||
      (entries ?? []).some((entry) => entry.repository === undefined),
    repositories: [...repositories],
  };
}
