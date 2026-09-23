/**
 * Desired-state type for the Entra ID side of SCIM provisioning: the
 * enterprise application that pushes security groups and their members into
 * GitHub, where the external-groups endpoints can then link them to teams.
 *
 * Nothing secret lives here. The provisioning credential Entra presents to
 * GitHub is a personal access token, and the manifest carries only the name
 * of the environment variable `cdkgithub scim` reads it from, the same
 * arrangement as an Actions secret's `valueFrom`.
 */

export interface ScimProvisioningManifest {
  /** The Entra tenant, as its GUID or a verified domain name. */
  readonly tenantId: string;
  /**
   * Display name of the enterprise application in Entra. The application is
   * found (and, when missing, created) by this name, so it is the identity
   * the setup is idempotent over.
   */
  readonly applicationDisplayName: string;
  /**
   * Environment variable holding the GitHub token Entra presents as the SCIM
   * bearer when it provisions. A classic token with `admin:org`, per GitHub's
   * SCIM documentation.
   */
  readonly tokenFrom: string;
  /** Display names of the Entra security groups to provision into GitHub. */
  readonly groups: string[];
}
