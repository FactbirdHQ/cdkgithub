/**
 * Author-facing shape for binding a team to an Entra ID (Azure AD) security group.
 *
 * GitHub links exactly ONE external IdP group to a team via the SCIM
 * external-groups API. With Entra ID as the IdP, only security groups are
 * supported (no nested groups, no Microsoft 365 groups).
 *
 * See: https://docs.github.com/en/enterprise-cloud@latest/rest/teams/external-groups
 */
export interface ExternalGroupProps {
  /**
   * Display name of the Entra security group, as it appears in GitHub's list of
   * external groups (`GET /orgs/{org}/external-groups`). Resolved to a numeric
   * group id at apply time.
   */
  readonly name?: string;

  /**
   * The GitHub external-group id, if already known. Takes precedence over `name`
   * and avoids a name lookup at apply time.
   */
  readonly id?: number;
}
