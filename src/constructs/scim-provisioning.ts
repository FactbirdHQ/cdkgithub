import { Construct } from 'constructs';

export interface ScimProvisioningProps {
  /** The Entra tenant the provisioning application lives in: its GUID, or a verified domain name. */
  readonly tenantId: string;

  /**
   * Display name of the enterprise application in Entra. `cdkgithub scim`
   * finds the application by this name and creates it from GitHub's gallery
   * template when it is missing, so the name is what makes reruns idempotent.
   * @default "GitHub SCIM (<org login>)"
   */
  readonly applicationDisplayName?: string;

  /**
   * Environment variable holding the GitHub token Entra presents as the SCIM
   * bearer. The token itself never appears in the definition, the manifest,
   * or anything else that reaches source control.
   * @default "GITHUB_SCIM_TOKEN"
   */
  readonly tokenFrom?: string;

  /**
   * Display names of the Entra security groups to provision. Omitted, the
   * list is derived from the definition itself: every `externalGroup` name a
   * `Team` declares, which keeps the groups a team links to and the groups
   * Entra pushes from drifting apart.
   */
  readonly groups?: string[];
}

/**
 * The Entra ID side of SCIM provisioning: the enterprise application that
 * pushes security groups and their members into GitHub.
 *
 * A team's `externalGroup` binding only links a group that has already been
 * provisioned; this construct is the configuration that provisions it.
 * `cdkgithub scim` reconciles it against Entra over Microsoft Graph: ensure
 * the application exists, ensure its provisioning job exists, write the
 * credentials from the environment, assign the groups, and start the job.
 * The command only ever adds; a group assigned in Entra outside this
 * definition is reported, never removed.
 *
 * Two things stay manual, because no public API covers them: creating the
 * GitHub token the provisioning presents, and enabling SCIM on the GitHub
 * organization.
 *
 * ```ts
 * new ScimProvisioning(org, "entra", {
 *   tenantId: "contoso.onmicrosoft.com",
 * });
 * ```
 */
export class ScimProvisioning extends Construct {
  public readonly props: ScimProvisioningProps;

  constructor(scope: Construct, id: string, props: ScimProvisioningProps) {
    super(scope, id);
    this.props = props;
  }
}
