import { Construct } from 'constructs';
import type { RepositoryAccess, TeamPrivacy } from '../synth/manifest.ts';
import type { RepositoryGrantList } from './grants.ts';
import type { ExternalGroupProps } from './external-group.ts';

export interface TeamProps {
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

  /** Usernames to add as team maintainers. */
  readonly maintainers?: string[];

  /** Usernames to add as plain members. */
  readonly members?: string[];

  /**
   * Repositories this team maintains, by name.
   *
   * The word is the permission: maintaining carries `maintain`, which is write
   * plus the repository's description, topics, Pages and pull-request merge
   * settings, and nothing that deletes, transfers or re-permissions it. That is
   * the whole of what answering for a repository needs, so it is not a choice
   * made per repository.
   *
   * Maintaining is exclusive: synthesis fails if two teams claim the same
   * repository, because "who answers for this" has one answer. Access is not,
   * so a team that needs a repository it does not maintain declares it in
   * {@link repositories} at whatever level it needs.
   *
   * A line in {@link repositories} still overrides what maintaining grants.
   */
  readonly maintains?: readonly string[];

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
 */
export class Team extends Construct {
  /** The team name (falls back to the construct id). */
  public readonly teamName: string;
  /** URL-safe slug GitHub uses to address the team. */
  public readonly slug: string;
  public readonly props: TeamProps;

  constructor(scope: Construct, id: string, props: TeamProps = {}) {
    super(scope, id);
    this.props = props;
    this.teamName = props.name ?? id;
    this.slug = Team.slugify(this.teamName);
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
