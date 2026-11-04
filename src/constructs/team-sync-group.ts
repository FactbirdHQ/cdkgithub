/**
 * An Entra ID security group a team's roster is synchronized from, through
 * GitHub team synchronization.
 *
 * Team synchronization is the mechanism for an organization whose members sign
 * in through Entra SAML single sign-on with their own GitHub accounts. An
 * enterprise with managed users links groups through SCIM instead, which is
 * {@link ExternalGroupProps}.
 *
 * See: https://docs.github.com/en/enterprise-cloud@latest/rest/teams/team-sync
 */
export interface TeamSyncGroupProps {
  /**
   * The group's Entra object id, a GUID. `GET /orgs/{org}/team-sync/groups`
   * lists the groups GitHub can see with their ids. The id survives a rename in
   * Entra, which is why it rather than the name identifies the group.
   */
  readonly id: string;

  /** The group's display name in Entra, which GitHub shows on the team. */
  readonly name: string;

  /** @default "" */
  readonly description?: string;
}
