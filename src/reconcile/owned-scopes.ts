import type { DesiredState } from '../synth/manifest.ts';

/** Every scope a secret or variable collection owns, resolved. */
export interface Scopes {
  readonly organization: boolean;
  readonly repositories: string[];
}

/**
 * The scopes whose secrets or variables the definition owns: the organization
 * it is defined against, every repository it declares, and every repository an
 * entry names by `repository` without declaring it.
 *
 * Ownership follows the declaration of the scope, not of an entry in it. A
 * scope owned only while an entry named it would drop out of the live read
 * with its last entry, and the secret that removal meant to delete would stay
 * on GitHub with nothing in the plan to say so. Repositories keep the order the
 * entries name them in, then the declared ones, so a plan lists changes in the
 * order the definition reads.
 */
export function scopesOf(
  entries: ReadonlyArray<{ repository?: string }> | undefined,
  desired: Pick<DesiredState, 'ownerType' | 'repositories'>,
): Scopes {
  const repositories = new Set<string>();
  for (const entry of entries ?? []) {
    if (entry.repository) repositories.add(entry.repository);
  }
  for (const repository of desired.repositories ?? []) {
    repositories.add(repository.name);
  }
  return {
    organization: desired.ownerType === 'organization',
    repositories: [...repositories],
  };
}
