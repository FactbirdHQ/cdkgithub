import type { ScimProvisioningManifest } from '../synth/scim.ts';
import type { EntraClient, EntraServicePrincipal } from './graph.ts';
import { scimTenantUrl } from './graph.ts';

export interface ScimSetupOptions {
  /** Execute the actions. Without it, the run reads, reports, and stops. */
  readonly yes: boolean;
  /** Where the provisioning token is read from, keyed by `tokenFrom`. */
  readonly env: Record<string, string | undefined>;
  readonly log: (line: string) => void;
}

export interface ScimSetupResult {
  /** What was done, or what `--yes` would do. */
  readonly actions: string[];
  /** Facts that need no action. */
  readonly notes: string[];
}

/**
 * Bring the Entra side of SCIM provisioning in line with the declaration:
 * the enterprise application exists, its provisioning job exists and holds
 * credentials, the declared groups are assigned to it, and the job runs.
 *
 * The whole computation happens read-only first (the application, its job,
 * its assignments, every group id, and the token's presence), and anything
 * that would make the run fail does so before the first write, so a typo in
 * a group name never leaves a half-configured application behind.
 *
 * Ensure-only: a group assigned to the application outside this definition
 * is reported, never unassigned, and nothing here deletes an application or
 * a job. Removing provisioning is an Entra decision to make in Entra.
 *
 * The provisioning token flows from the environment through
 * {@link EntraClient.setSynchronizationSecrets} and appears in no output and
 * no return value.
 */
export async function setUpScimProvisioning(
  entra: EntraClient,
  owner: string,
  manifest: ScimProvisioningManifest,
  options: ScimSetupOptions,
): Promise<ScimSetupResult> {
  const { log } = options;
  const actions: string[] = [];
  const notes: string[] = [];

  // The Graph token decides which tenant is written to, and it is easy to be
  // signed into the wrong one. The declaration names the tenant it means, so
  // a mismatch is a refusal, not a surprise in someone else's directory.
  const tenant = await entra.describeTenant();
  if (!tenantMatches(manifest.tenantId, tenant)) {
    throw new Error(
      `The Graph token reaches tenant ${tenant.id} (${tenant.domains.join(', ')}), ` +
        `but the definition declares "${manifest.tenantId}". Sign into the declared tenant and re-run.`,
    );
  }

  const name = manifest.applicationDisplayName;
  let servicePrincipal = await entra.findServicePrincipal(name);
  const jobs = servicePrincipal
    ? await entra.listSynchronizationJobs(servicePrincipal.id)
    : [];
  const assigned = servicePrincipal
    ? await entra.listAssignedGroups(servicePrincipal.id)
    : [];

  const groupIds = new Map<string, string>();
  const missing: string[] = [];
  for (const group of manifest.groups) {
    const id = await entra.findGroupId(group);
    if (id === undefined) missing.push(group);
    else groupIds.set(group, id);
  }
  if (missing.length > 0) {
    throw new Error(
      `No Entra security group is named ${missing.map((g) => `"${g}"`).join(', ')}. ` +
        'Nothing was configured.',
    );
  }

  const creatingApplication = servicePrincipal === undefined;
  const creatingJob = creatingApplication || jobs.length === 0;
  const existingJob = jobs[0];
  const token = options.env[manifest.tokenFrom];

  // A dry run without the token still shows the whole plan; only a run that
  // would write credentials refuses without them.
  if (creatingJob && token === undefined) {
    if (options.yes) {
      throw new Error(
        `Configuring provisioning needs the GitHub token from $${manifest.tokenFrom}, which is not set. ` +
          'Export it and re-run. Nothing was configured.',
      );
    }
    notes.push(`--yes will need $${manifest.tokenFrom} exported`);
  }

  if (creatingApplication) {
    actions.push(`create enterprise application "${name}" from GitHub's gallery template`);
  }
  if (creatingJob) {
    actions.push('create the provisioning job');
    actions.push(
      `write its credentials: ${scimTenantUrl(owner)}, token from $${manifest.tokenFrom}`,
    );
  } else if (token !== undefined) {
    actions.push(
      `refresh the provisioning credentials from $${manifest.tokenFrom}`,
    );
  } else {
    notes.push(
      `credentials kept as stored; export $${manifest.tokenFrom} to rotate them`,
    );
  }

  const assignedIds = new Set(assigned.map((a) => a.groupId));
  const toAssign = [...groupIds].filter(([, id]) => !assignedIds.has(id));
  for (const [group] of toAssign) {
    actions.push(`assign group "${group}" to the application`);
  }

  const declaredIds = new Set(groupIds.values());
  const unmanaged = assigned.filter((a) => !declaredIds.has(a.groupId));
  if (unmanaged.length > 0) {
    notes.push(
      `assigned outside this definition, left alone: ${unmanaged
        .map((a) => `"${a.displayName}"`)
        .join(', ')}`,
    );
  }

  const startJob =
    creatingJob || (existingJob !== undefined && existingJob.state !== 'Active');
  if (startJob) {
    actions.push(
      creatingJob
        ? 'start provisioning'
        : `start provisioning (job state is ${existingJob?.state ?? 'unknown'})`,
    );
  }

  if (!options.yes) return { actions, notes };

  if (creatingApplication) {
    log(`Creating enterprise application "${name}"`);
    servicePrincipal = await entra.instantiateGalleryApplication(name);
  }
  const principal = servicePrincipal as EntraServicePrincipal;

  let jobId = existingJob?.id;
  if (creatingJob) {
    log('Creating the provisioning job');
    jobId = (await entra.createSynchronizationJob(principal.id)).id;
  }
  if (token !== undefined) {
    log(`Writing provisioning credentials from $${manifest.tokenFrom}`);
    await entra.setSynchronizationSecrets(
      principal.id,
      scimTenantUrl(owner),
      token,
    );
  }
  for (const [group, id] of toAssign) {
    log(`Assigning group "${group}"`);
    await entra.assignGroup(principal, id);
  }
  if (startJob && jobId !== undefined) {
    log('Starting provisioning');
    await entra.startSynchronizationJob(principal.id, jobId);
  }

  return { actions, notes };
}

/** Whether the declared tenant names the one the token reaches. */
function tenantMatches(
  declared: string,
  tenant: { id: string; domains: string[] },
): boolean {
  const wanted = declared.toLowerCase();
  return (
    tenant.id.toLowerCase() === wanted ||
    tenant.domains.some((domain) => domain.toLowerCase() === wanted)
  );
}
