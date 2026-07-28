import { Construct } from "constructs";
import type {
  RepositoryAccess,
  TeamPrivacy,
} from "../synth/manifest.ts";
import type { ExternalGroupProps } from "./external-group.ts";

export interface TeamProps {
  /**
   * Human-readable team name. Defaults to the construct id.
   * The GitHub slug is derived from this name.
   */
  readonly name?: string;

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

  /** Repository access grants: `{ "repo-name": "push" }`. */
  readonly repositories?: RepositoryAccess;

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
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
