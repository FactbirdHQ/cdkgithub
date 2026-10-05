/**
 * The Microsoft Graph surface `cdkgithub scim` uses to configure Entra ID
 * provisioning, behind an interface so tests can supply an in-memory fake the
 * way they do for GitHub.
 *
 * Everything here is the enterprise-application machinery of one gallery app:
 * GitHub's own provisioning template, its synchronization job, the credential
 * pair the job presents to GitHub, and the group assignments that scope what
 * it pushes. Secret values pass through {@link EntraClient.setSynchronizationSecrets}
 * on their way to Entra and are never read back, because Graph offers no read.
 */

/** The gallery template GitHub documents for provisioning one organization. */
export const GITHUB_ORGANIZATION_TEMPLATE = 'GitHub Enterprise Cloud - Organization';

/** The SCIM base URL Entra provisions against, per GitHub's documentation. */
export function scimTenantUrl(org: string): string {
  return `https://api.github.com/scim/v2/organizations/${org}`;
}

export interface EntraServicePrincipal {
  readonly id: string;
  readonly appId: string;
  /** The roles a group can be assigned into; scopes what the job provisions. */
  readonly appRoles: Array<{
    id: string;
    displayName?: string;
    isEnabled?: boolean;
  }>;
}

export interface EntraSynchronizationJob {
  readonly id: string;
  /** `Active`, `Paused`, `Quarantine`, or `NotConfigured`. */
  readonly state?: string;
}

/** One group assigned to the application, and therefore provisioned. */
export interface EntraGroupAssignment {
  readonly groupId: string;
  readonly displayName: string;
}

export interface EntraClient {
  /** The tenant the token reaches: its id and its verified domain names. */
  describeTenant(): Promise<{ id: string; domains: string[] }>;
  findServicePrincipal(
    displayName: string,
  ): Promise<EntraServicePrincipal | undefined>;
  /** Instantiate the GitHub gallery template under the given display name. */
  instantiateGalleryApplication(
    displayName: string,
  ): Promise<EntraServicePrincipal>;
  listSynchronizationJobs(
    servicePrincipalId: string,
  ): Promise<EntraSynchronizationJob[]>;
  /** Create the provisioning job from the application's own template. */
  createSynchronizationJob(
    servicePrincipalId: string,
  ): Promise<EntraSynchronizationJob>;
  /** Write the credential pair the job presents to GitHub. Never read back. */
  setSynchronizationSecrets(
    servicePrincipalId: string,
    tenantUrl: string,
    secretToken: string,
  ): Promise<void>;
  startSynchronizationJob(
    servicePrincipalId: string,
    jobId: string,
  ): Promise<void>;
  /** The group's object id, or undefined when no group carries the name. */
  findGroupId(displayName: string): Promise<string | undefined>;
  listAssignedGroups(
    servicePrincipalId: string,
  ): Promise<EntraGroupAssignment[]>;
  assignGroup(
    servicePrincipal: EntraServicePrincipal,
    groupId: string,
  ): Promise<void>;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Default {@link EntraClient} against Microsoft Graph. */
export class MsGraphEntraClient implements EntraClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl: string = GRAPH) {
    this.token = token;
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = path.startsWith('https://') ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const detail = await graphError(response);
      throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** Every page of a Graph collection, following `@odata.nextLink`. */
  private async list<T>(path: string): Promise<T[]> {
    interface Page {
      value?: T[];
      '@odata.nextLink'?: string;
    }
    const all: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page: Page = await this.request<Page>('GET', next);
      all.push(...(page.value ?? []));
      next = page['@odata.nextLink'];
    }
    return all;
  }

  async describeTenant(): Promise<{ id: string; domains: string[] }> {
    const organizations = await this.list<{
      id: string;
      verifiedDomains?: Array<{ name?: string }>;
    }>('/organization?$select=id,verifiedDomains');
    const tenant = organizations[0];
    if (!tenant) {
      throw new Error('Microsoft Graph returned no organization for this token.');
    }
    return {
      id: tenant.id,
      domains: (tenant.verifiedDomains ?? []).flatMap((d) =>
        d.name ? [d.name] : [],
      ),
    };
  }

  async findServicePrincipal(
    displayName: string,
  ): Promise<EntraServicePrincipal | undefined> {
    const matches = await this.list<EntraServicePrincipal>(
      `/servicePrincipals?$filter=displayName eq ${quote(displayName)}&$select=id,appId,appRoles`,
    );
    return matches[0];
  }

  async instantiateGalleryApplication(
    displayName: string,
  ): Promise<EntraServicePrincipal> {
    const templates = await this.list<{ id: string }>(
      `/applicationTemplates?$filter=displayName eq ${quote(GITHUB_ORGANIZATION_TEMPLATE)}`,
    );
    const template = templates[0];
    if (!template) {
      throw new Error(
        `The Entra application gallery has no template named "${GITHUB_ORGANIZATION_TEMPLATE}".`,
      );
    }
    const { servicePrincipal } = await this.request<{
      servicePrincipal?: { id: string; appId: string };
    }>('POST', `/applicationTemplates/${template.id}/instantiate`, {
      displayName,
    });
    if (!servicePrincipal) {
      throw new Error(
        `Instantiating "${displayName}" returned no service principal.`,
      );
    }
    // The instantiate response omits appRoles; read the principal back whole,
    // since the roles are what group assignment needs.
    const full = await this.request<EntraServicePrincipal>(
      'GET',
      `/servicePrincipals/${servicePrincipal.id}?$select=id,appId,appRoles`,
    );
    return full;
  }

  async listSynchronizationJobs(
    servicePrincipalId: string,
  ): Promise<EntraSynchronizationJob[]> {
    const jobs = await this.list<{
      id: string;
      status?: { code?: string };
    }>(`/servicePrincipals/${servicePrincipalId}/synchronization/jobs`);
    return jobs.map((j) => ({ id: j.id, state: j.status?.code }));
  }

  async createSynchronizationJob(
    servicePrincipalId: string,
  ): Promise<EntraSynchronizationJob> {
    const templates = await this.list<{ id: string }>(
      `/servicePrincipals/${servicePrincipalId}/synchronization/templates`,
    );
    const template = templates[0];
    if (!template) {
      throw new Error(
        'The application exposes no synchronization template, so no provisioning job can be created on it.',
      );
    }
    const job = await this.request<{ id: string }>(
      'POST',
      `/servicePrincipals/${servicePrincipalId}/synchronization/jobs`,
      { templateId: template.id },
    );
    return { id: job.id };
  }

  async setSynchronizationSecrets(
    servicePrincipalId: string,
    tenantUrl: string,
    secretToken: string,
  ): Promise<void> {
    await this.request(
      'PUT',
      `/servicePrincipals/${servicePrincipalId}/synchronization/secrets`,
      {
        value: [
          { key: 'BaseAddress', value: tenantUrl },
          { key: 'SecretToken', value: secretToken },
        ],
      },
    );
  }

  async startSynchronizationJob(
    servicePrincipalId: string,
    jobId: string,
  ): Promise<void> {
    await this.request(
      'POST',
      `/servicePrincipals/${servicePrincipalId}/synchronization/jobs/${jobId}/start`,
      {},
    );
  }

  async findGroupId(displayName: string): Promise<string | undefined> {
    const groups = await this.list<{ id: string }>(
      `/groups?$filter=displayName eq ${quote(displayName)}&$select=id`,
    );
    return groups[0]?.id;
  }

  async listAssignedGroups(
    servicePrincipalId: string,
  ): Promise<EntraGroupAssignment[]> {
    const assignments = await this.list<{
      principalId?: string;
      principalType?: string;
      principalDisplayName?: string;
    }>(`/servicePrincipals/${servicePrincipalId}/appRoleAssignedTo`);
    return assignments.flatMap((a) =>
      a.principalType === 'Group' && a.principalId
        ? [{ groupId: a.principalId, displayName: a.principalDisplayName ?? '' }]
        : [],
    );
  }

  async assignGroup(
    servicePrincipal: EntraServicePrincipal,
    groupId: string,
  ): Promise<void> {
    await this.request('POST', `/groups/${groupId}/appRoleAssignments`, {
      principalId: groupId,
      resourceId: servicePrincipal.id,
      appRoleId: pickAppRole(servicePrincipal),
    });
  }
}

/**
 * The role a group is assigned into. Gallery apps ship a "User" role; failing
 * both that and any enabled role, the zero GUID is Graph's "default access".
 */
function pickAppRole(servicePrincipal: EntraServicePrincipal): string {
  const roles = servicePrincipal.appRoles.filter((r) => r.isEnabled !== false);
  return (
    roles.find((r) => r.displayName === 'User')?.id ??
    roles[0]?.id ??
    '00000000-0000-0000-0000-000000000000'
  );
}

/** An OData string literal: single quotes, embedded ones doubled. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function graphError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    return body.error?.message ?? body.error?.code ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
