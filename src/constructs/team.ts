import { Construct } from 'constructs';

import type { RepositoryAccess, TeamNotificationSetting, TeamPrivacy } from '../synth/manifest.ts';
import type { VocabularyMember } from '../vocabulary.ts';
import type { ExternalGroupProps } from './external-group.ts';
import type { RepositoryGrantList } from './grants.ts';

export interface TeamProps<Member extends string = VocabularyMember> {
  /**
   * Human-readable team name. Defaults to the construct id.
   * The GitHub slug is derived from this name.
   */
  readonly name?: string;

  /**
   * The slug this team carries on GitHub right now, when a new `name` no longer
   * derives it. Set it to rename the team in place.
   *
   * Identity is the slug, so without this a renamed team reads as one team
   * deleted and another created: the id changes, the members are notified, and
   * the history goes. With it, cdkgithub finds the live team under the old slug
   * and renames it, which is what GitHub's own endpoint does.
   *
   * The marker is idempotent. Once the rename has landed, the live slug matches
   * the derived one, the lookup never falls back, and the line can be deleted at
   * leisure.
   */
  readonly previousSlug?: string;

  readonly description?: string;

  /**
   * Team visibility. Defaults to `closed` (visible to all org members), which is
   * required for nested/parent teams.
   */
  readonly privacy?: TeamPrivacy;

  /**
   * Whether an `@org/team` mention notifies the team's members, the toggle
   * under the team's settings. Left unset, the live setting is not managed: a
   * new team starts with GitHub's default, `notifications_enabled`.
   */
  readonly notificationSetting?: TeamNotificationSetting;

  /** Usernames to add as team maintainers. */
  readonly maintainers?: readonly Member[];

  /** Usernames to add as plain members. */
  readonly members?: readonly Member[];

  /**
   * Repository access grants, as a map or as a list of one-repository grants:
   * `{ netcore: "push" }` or `[push("netcore")]`.
   *
   * Each helper takes many repositories, so a category is granted by spreading
   * it: `[push('netcore'), triage(...systemII)]`. The list form reads
   * permission-first, which is the part worth seeing in a column of forty
   * repositories. Synthesis rejects a repository granted twice
   * in one list; the map form cannot express that.
   */
  readonly repositories?: RepositoryAccess | readonly RepositoryGrantList[];

  /**
   * Link this team to an Entra ID security group via SCIM. When set, membership
   * is expected to be driven by the IdP rather than the `members` list.
   */
  readonly externalGroup?: ExternalGroupProps;
}

/**
 * A GitHub team.
 *
 * Nesting is expressed through the construct tree: a `Team` whose scope is
 * another `Team` becomes a child (GitHub `parent_team_id`) of that team. A team
 * scoped directly under an `Organization` is top-level.
 *
 * A child can be added with {@link Team.addSubTeam} or made with
 * `new Team(parent, …)`, and the two synthesize identically; so does a subclass
 * that constructs its children in its own constructor. Unlike the other child
 * constructs there is no record prop for them: a team tree reads as the chain
 * or the classes that build it, not as a nested literal.
 */
export class Team<Member extends string = VocabularyMember> extends Construct {
  /** The team name (falls back to the construct id). */
  public readonly teamName: string;
  /** URL-safe slug GitHub uses to address the team. */
  public readonly slug: string;
  public readonly props: TeamProps<Member>;

  constructor(scope: Construct, id: string, props: TeamProps<Member> = {}) {
    super(scope, id);
    this.props = props;
    this.teamName = props.name ?? id;
    this.slug = Team.slugify(this.teamName);
  }

  /** Declare a child team of this one. */
  addSubTeam(id: string, props: TeamProps<Member> = {}): Team<Member> {
    return new Team<Member>(this, id, props);
  }

  /**
   * Approximate GitHub's team-slug derivation: lowercase, non-alphanumeric runs
   * become single hyphens, trimmed of leading/trailing hyphens.
   */
  static slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
}

/**
 * A {@link Team} whose rosters may only name people you have declared.
 *
 * `Team` is generic over its roster, but a type parameter is only ever
 * *inferred* from the argument, so `new Team(org, 'x', { members: ['ana'] })`
 * infers `'ana'` from the literal rather than checking it against anything. To
 * constrain it, the parameter has to be bound, and binding it at every call is
 * what `satisfies` was already doing by hand.
 *
 * Bind it once instead:
 *
 * ```ts
 * // team.ts, beside the list of people
 * export const USERS = ['ana', 'bo'] as const;
 * export const Team = teamOf<(typeof USERS)[number]>();
 *
 * // and everywhere a team is declared
 * new Team(org, 'cloud', { members: ['ana'] });   // 'anna' does not compile
 * ```
 *
 * The result is the same class: `instanceof Team` still holds, because it is
 * the same constructor with a narrower parameter type.
 */
export function teamOf<Member extends string>(): new (
  scope: Construct,
  id: string,
  props?: TeamProps<Member>,
) => Team<Member> {
  return Team;
}
