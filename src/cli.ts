import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { MsGraphEntraClient } from './entra/graph.ts';
import { setUpScimProvisioning } from './entra/scim-setup.ts';
import { resolveGraphToken } from './entra/token.ts';
import { OctokitGitHubClient } from './github/client.ts';
import { resolveToken } from './github/token.ts';
import { importOrganization } from './import/import-org.ts';
import { apply, deleteAllowed } from './reconcile/applier.ts';
import { writeBackup } from './reconcile/backup.ts';
import {
  type Change,
  DELETE_SCOPES,
  type DeleteScope,
  type DestructiveKind,
  isDestructive,
} from './reconcile/changes.ts';
import { readLiveState } from './reconcile/live.ts';
import { unmanagedRoleAssignments } from './reconcile/plan-org-roles.ts';
import { plan } from './reconcile/planner.ts';
import { diffAccessByPerson } from './reconcile/access-by-person.ts';
import { choosePalette } from './reconcile/color.ts';
import {
  orphanRepositories,
  renderOrphans,
} from './reconcile/orphan-repositories.ts';
import {
  renderAccessByPerson,
  renderAccessCsv,
} from './reconcile/render-person.ts';
import {
  renderRedundant,
  renderTree,
  renderTreeDiff,
} from './reconcile/render-tree.ts';
import { renderPlan } from './reconcile/render.ts';
import {
  desiredTree,
  readLiveTree,
  redundantGrants,
} from './reconcile/tree.ts';
import { diffTrees } from './reconcile/tree-diff.ts';
import type { DesiredState, ManifestProvenance } from './synth/manifest.ts';
import { validateManifest } from './synth/validate.ts';
import { collectWarnings } from './synth/warnings.ts';

const USAGE = `cdkgithub — define GitHub org team structure as code

Usage:
  cdkgithub synth <config.ts>      Run a definition and write github.out/manifest.json
  cdkgithub diff  [options]        Compare the live org tree against the manifest
  cdkgithub plan  [options]        Diff the manifest against the live org (read-only)
  cdkgithub apply [options]        Reconcile the live org to match the manifest
  cdkgithub import <org>           Read a live org and emit a definition (read-only)
  cdkgithub scim  [options]        Configure Entra ID SCIM provisioning to match
                                   the manifest's ScimProvisioning declaration.
                                   Dry run without --yes.

Options:
  --output <path>     Where import writes the definition (default: stdout)
  --repositories[=names]
                      Make import walk repositories and read their rulesets,
                      variables, and secrets too. Bare, every repository; with
                      names, only those. One round of requests per repository.
  --manifest <path>   Manifest to read for plan/apply (default: github.out/manifest.json)
  --yes               Actually execute changes (apply). Without it, apply is a dry run.
  --allow-delete[=scopes]
                      Permit deleting resources absent from the manifest. Bare, it
                      permits every kind; with scopes, only those named. Scopes:
                      ${Object.keys(DELETE_SCOPES).join(', ')}.
  --require-approval <never|destructive|any-change>
                      When apply pauses for an interactive "y" before writing
                      (default: destructive). In automation, pass "never".
  --force             Skip the guard that refuses to delete most of the org's
                      teams in one run.
  --enable-scim       Perform Entra ID (SCIM) external-group linking.
  --full              Expand every team, listing every grant rather than a sample.
  --changed-only      Hide teams whose whole subtree matches (diff).
  --live              Print the live org tree and stop, without comparing (diff).
  --by-person         Pivot the diff onto people: the repositories each one can
                      reach, before and after, and the team granting each.
  --csv               Emit --by-person as CSV, one row per person per repository.
  --color / --no-color  Force color on or off. The default colors a terminal and
                      leaves a pipe or a file plain; NO_COLOR is honoured.

Every apply that writes first saves a backup under github.out/backups/<time>/:
the live state it read, a rollback manifest that restores the team structure
when applied with --manifest, the plan, and a journal of each change.

Auth: uses GITHUB_TOKEN/GH_TOKEN, else falls back to \`gh auth token\`. Managing
teams needs org-admin scope; the governance surfaces additionally need admin:org,
and code security configurations need the org to have those features available.
\`scim\` additionally talks to Microsoft Graph: it uses AZURE_GRAPH_TOKEN, else
falls back to \`az account get-access-token\`, and reads the GitHub token Entra
will provision with from the environment variable the definition names.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  let flags: Flags;
  try {
    flags = parseFlags(rest, command);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
    );
    return 1;
  }

  switch (command) {
    case 'synth':
      return synthCommand(rest[0]);
    case 'diff':
      return diffCommand(flags);
    case 'plan':
      return planCommand(flags);
    case 'apply':
      return applyCommand(flags);
    case 'import':
      return importCommand(flags);
    case 'scim':
      return scimCommand(flags);
    case '-h':
    case '--help':
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

async function synthCommand(configPath: string | undefined): Promise<number> {
  if (!configPath) {
    console.error(
      'synth requires a config file, e.g. `cdkgithub synth examples/factbird.ts`',
    );
    return 1;
  }
  // The config module constructs an App and calls app.synth() on load.
  await import(pathToFileURL(resolve(configPath)).href);
  stampProvenance('github.out/manifest.json', configPath);
  return 0;
}

/**
 * Record in the manifest where it came from, so every plan can say which
 * definition and commit it is acting for. Best-effort: a config that writes to
 * a custom outdir is simply not stamped.
 */
function stampProvenance(manifestPath: string, configPath: string): void {
  let manifest: DesiredState;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DesiredState;
  } catch {
    return;
  }

  const provenance: ManifestProvenance = {
    source: configPath,
    synthesizedAt: new Date().toISOString(),
    ...gitState(),
  };
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, provenance }, null, 2)}\n`,
  );
}

/** The commit the working tree is on, and whether it is dirty, when in git. */
function gitState(): { commit?: string; dirty?: boolean } {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (head.status !== 0) return {};
  const status = spawnSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return {
    commit: head.stdout.trim(),
    dirty: status.status === 0 ? status.stdout.trim() !== '' : undefined,
  };
}

/**
 * Read a live organization and emit a definition file: the inverse of `synth`,
 * for adopting an organization built by hand. Read-only, like `plan`.
 */
async function importCommand(flags: Flags): Promise<number> {
  const org = flags.positional;
  if (!org) {
    console.error(
      'import requires an organization login, e.g. `cdkgithub import factbird`',
    );
    return 1;
  }
  const client = new OctokitGitHubClient(resolveToken());
  const definition = await importOrganization(client, org, {
    repositories: flags.repositories,
  });
  if (flags.output) {
    writeFileSync(flags.output, definition);
    console.error(`Definition written to ${flags.output}`);
    return 0;
  }
  console.log(definition);
  return 0;
}

/**
 * Configure the Entra side of SCIM provisioning to match the declaration.
 *
 * A separate command rather than part of `apply`, because it writes to a
 * different provider under different credentials: `apply --enable-scim`
 * remains the GitHub half, linking teams to groups this command provisions.
 * Like `apply`, it is a dry run until `--yes`.
 */
async function scimCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const scim = desired.scim;
  if (!scim) {
    console.error(
      'The manifest declares no SCIM provisioning. Add a ScimProvisioning ' +
        'construct to the definition and re-run `cdkgithub synth`.',
    );
    return 1;
  }

  printProvenance(desired);
  const entra = new MsGraphEntraClient(resolveGraphToken());

  let result;
  try {
    result = await setUpScimProvisioning(entra, desired.owner, scim, {
      yes: flags.yes,
      env: process.env,
      log: (line) => console.log(`  ${line}`),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (result.actions.length === 0) {
    console.log('Entra already matches the declaration.');
  } else if (flags.yes) {
    console.log(
      `\nConfigured: ${result.actions.length} action${result.actions.length === 1 ? '' : 's'}.`,
    );
  } else {
    console.log(`SCIM setup for organization "${desired.owner}":\n`);
    for (const action of result.actions) console.log(`  + ${action}`);
  }
  for (const note of result.notes) console.log(`  note: ${note}`);

  await reportProvisionedGroups(desired.owner, scim.groups);

  if (!flags.yes && result.actions.length > 0) {
    console.log('\nDry run. Re-run with --yes to configure Entra.');
  }
  return 0;
}

/**
 * Which declared groups GitHub can already see, so an operator knows when the
 * push has landed and `apply --enable-scim` will link. Advisory: a missing
 * GitHub token degrades to a note, not a failure, because the Entra half of
 * the run is complete either way.
 */
async function reportProvisionedGroups(
  owner: string,
  groups: readonly string[],
): Promise<void> {
  try {
    const client = new OctokitGitHubClient(resolveToken());
    const visible = new Set(
      (await client.listExternalGroups(owner)).map((g) => g.name),
    );
    const there = groups.filter((g) => visible.has(g));
    const pending = groups.filter((g) => !visible.has(g));
    if (there.length > 0) {
      console.log(
        `\nVisible in GitHub already: ${there.join(', ')}. Link with \`apply --enable-scim\`.`,
      );
    }
    if (pending.length > 0) {
      console.log(
        `${there.length > 0 ? '' : '\n'}Not visible in GitHub yet: ${pending.join(', ')}. ` +
          'Provisioning runs on Entra\'s schedule (up to 40 minutes).',
      );
    }
  } catch (error) {
    console.error(
      `note: could not check GitHub's external groups (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

async function planCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const client = new OctokitGitHubClient(resolveToken());
  const live = await readLiveState(client, desired);
  const changes = plan(desired, live);
  printWarnings(desired);
  printProvenance(desired);
  console.log(`Plan for ${describeOwner(desired)}:\n`);
  console.log(renderPlan(changes));
  printUnmanagedRoles(desired, live);
  return 0;
}

/**
 * Organization roles the definition does not account for.
 *
 * A role can carry a repository permission on every repository at once, so an
 * assignment nobody wrote down is a wider access path than any team grant, and
 * invisible until it is printed.
 */
function printUnmanagedRoles(
  desired: DesiredState,
  live: Awaited<ReturnType<typeof readLiveState>>,
): void {
  const unmanaged = unmanagedRoleAssignments(desired.organizationRoles, live);
  if (unmanaged.length === 0) return;

  console.log('\nOrganization roles held outside this definition:');
  for (const role of unmanaged) {
    const base = role.baseRole ? ` (${role.baseRole} on every repository)` : '';
    const who = [...role.teams.map((t) => `team ${t}`), ...role.users].join(
      ', ',
    );
    console.log(`  ${role.role}${base}: ${who}`);
  }
}

async function applyCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const client = new OctokitGitHubClient(resolveToken());
  const live = await readLiveState(client, desired);
  const changes = plan(desired, live);

  printWarnings(desired);
  printProvenance(desired);
  console.log(`Plan for ${describeOwner(desired)}:\n`);
  console.log(renderPlan(changes));
  console.log('');

  if (!flags.yes) {
    console.log('Dry run. Re-run with --yes to apply these changes.');
    return 0;
  }

  const allowDelete = resolveAllowDelete(flags.allowDelete);
  const executable = changes.filter(
    (c) =>
      deleteAllowed(c, allowDelete) &&
      !(c.kind === 'link-group' && !flags.enableScim),
  );
  if (executable.length === 0) {
    console.log('Nothing to apply.');
    return 0;
  }

  const guard = massDeleteGuard(executable, live.teams.length, flags.force);
  if (guard) {
    console.error(guard);
    return 1;
  }

  const missingSecrets = missingSecretValues(executable, process.env);
  if (missingSecrets.length > 0) {
    console.error(
      `This plan writes secrets whose values are not in the environment: ` +
        `${missingSecrets.map((name) => `$${name}`).join(', ')}. ` +
        'Export them and re-run apply. Nothing was changed.',
    );
    return 1;
  }

  if (!(await approved(executable, flags.requireApproval))) return 1;

  const backup = writeBackup('github.out', desired, live, executable);
  console.log(`Backup written to ${backup.dir} (rollback-manifest.json reverts the team structure).\n`);

  try {
    const result = await apply(client, desired.owner, changes, live, {
      allowDelete,
      enableScim: flags.enableScim,
      onProgress: (m) => console.log(`  ${m}`),
      onRecord: backup.journal,
    });

    console.log(
      `\nApplied: ${result.created} created, ${result.updated} updated, ` +
        `${result.linked} linked, ${result.deleted} deleted, ` +
        `${result.governance} governance change${result.governance === 1 ? '' : 's'}.`,
    );
    for (const s of result.skipped) console.log(`  skipped: ${s}`);
    return 0;
  } catch (error) {
    console.error(
      `\napply stopped: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      `The organization is partially reconciled. ${backup.dir}/journal.jsonl ` +
        'says what was applied; re-running apply continues from live state, ' +
        `and ${backup.dir}/rollback-manifest.json restores the team structure.`,
    );
    return 1;
  }
}

/** Turn the flag value into what {@link apply} takes. */
function resolveAllowDelete(
  value: Flags['allowDelete'],
): boolean | ReadonlySet<DestructiveKind> {
  if (typeof value === 'boolean') return value;
  return new Set(value.map((scope) => DELETE_SCOPES[scope]));
}

/**
 * The environment variables the plan's secret writes read from, minus the ones
 * that are set. Checked whole before anything is written or approved: failing
 * on the second secret mid-apply would leave the organization partially
 * reconciled over a missing export.
 */
export function missingSecretValues(
  executable: Change[],
  env: Record<string, string | undefined>,
): string[] {
  const missing = new Set<string>();
  for (const change of executable) {
    if (change.kind === 'put-secret' && env[change.secret.valueFrom] === undefined) {
      missing.add(change.secret.valueFrom);
    }
  }
  return [...missing];
}

/**
 * Refuse to delete most of the organization's teams in one run without
 * `--force`. A plan like that is far more often a truncated or stale manifest
 * than an intended restructuring, and it is the one mistake a gate flag passed
 * out of habit would not catch.
 */
export function massDeleteGuard(
  executable: Change[],
  liveTeamCount: number,
  force: boolean,
): string | undefined {
  if (force) return undefined;
  const teamDeletes = executable.filter((c) => c.kind === 'delete').length;
  if (teamDeletes < 3 || teamDeletes * 2 < liveTeamCount) return undefined;
  return (
    `Refusing to delete ${teamDeletes} of ${liveTeamCount} teams in one run. ` +
    'If the manifest is current and this is intended, re-run with --force; ' +
    'otherwise re-run `cdkgithub synth` first.'
  );
}

/**
 * The interactive gate before writing, in the shape of \`cdk deploy\`'s
 * --require-approval: "destructive" pauses when a change removes something,
 * "any-change" always pauses, "never" never does. Where there is no terminal
 * to ask, the run fails rather than assumes.
 */
async function approved(
  executable: Change[],
  level: RequireApproval,
): Promise<boolean> {
  if (level === 'never') return true;
  const needing =
    level === 'any-change' ? executable : executable.filter(isDestructive);
  if (needing.length === 0) return true;

  const destructive = executable.filter(isDestructive).length;
  console.log(
    `${executable.length} change${executable.length === 1 ? '' : 's'} to apply, ` +
      `${destructive} destructive.`,
  );

  if (!process.stdin.isTTY) {
    console.error(
      `"--require-approval ${level}" needs a terminal to ask on. ` +
        'In automation, review the plan first and pass --require-approval never.',
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (
    await rl.question('Do you wish to apply these changes (y/n)? ')
  )
    .trim()
    .toLowerCase();
  rl.close();
  if (answer === 'y' || answer === 'yes') return true;
  console.log('Aborted. Nothing was changed.');
  return false;
}

function describeOwner(desired: DesiredState): string {
  const kind = desired.ownerType === 'user' ? 'user' : 'organization';
  return `${kind} "${desired.owner}"`;
}

/** Advisory diagnostics, on stderr so piping the plan to a file keeps them visible. */
function printWarnings(desired: DesiredState): void {
  for (const warning of collectWarnings(desired)) {
    console.error(`warning: ${warning}\n`);
  }
}

/** Which definition and commit this manifest speaks for, when synth stamped it. */
function printProvenance(desired: DesiredState): void {
  const p = desired.provenance;
  if (!p) return;
  const commit = p.commit
    ? ` at ${p.commit.slice(0, 7)}${p.dirty ? ' (dirty working tree)' : ''}`
    : '';
  console.log(`Manifest: ${p.source}${commit}, synthesized ${p.synthesizedAt}\n`);
}

function readManifest(path: string): DesiredState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read manifest at "${path}" ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Run `cdkgithub synth` first.',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Manifest at "${path}" is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        'Re-run `cdkgithub synth`.',
    );
  }
  return validateManifest(parsed, path);
}

/**
 * Read the live organization, render it as a tree, and compare it against the
 * synthesized one.
 *
 * This reads every team whole, where `plan` reads only the surfaces a team
 * declares. Nothing here is applied, so a team the definition leaves alone still
 * appears in the tree next to the ones it owns.
 */
async function diffCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const client = new OctokitGitHubClient(resolveToken());
  // Direct collaborators are read only for a definition that manages them,
  // and only on the repositories it declares, the same scope `plan` reads.
  const collaboratorRepositories = desired.collaborators
    ? [
        ...new Set([
          ...(desired.repositories ?? []).map((r) => r.name),
          ...desired.collaborators.map((c) => c.repository),
        ]),
      ]
    : [];
  const live = await readLiveTree(
    client,
    desired.owner,
    desired.ownerType,
    collaboratorRepositories,
  );
  const palette = choosePalette({
    flag: flags.color,
    isTTY: process.stdout.isTTY === true,
    env: process.env,
  });

  if (flags.live) {
    console.log(renderTree(live, { palette }));
    return 0;
  }

  printWarnings(desired);
  // The live roles rank a grant made through a custom repository role, so both
  // sides order it the same way instead of reading as drift.
  // The live roles also say what an organization role reaches, and the live
  // repositories are the estate such a role reaches over: both sides of the
  // comparison are then measured against the same organization.
  const wanted = desiredTree(
    desired,
    live.customRoles,
    live.orgRoles,
    live.repositories,
  );

  // The same two trees, read down the other axis: who reaches what, rather than
  // what changes. An access review asks the first and a code review the second.
  if (flags.byPerson) {
    const people = diffAccessByPerson(live, wanted);
    if (flags.csv) {
      console.log(renderAccessCsv(people));
      return 0;
    }
    console.log(`Repository access for ${describeOwner(desired)}:
`);
    console.log(
      renderAccessByPerson(people, {
        full: flags.full,
        changedOnly: flags.changedOnly,
        palette,
      }),
    );
    return 0;
  }

  console.log(`Tree diff for ${describeOwner(desired)}:
`);
  console.log(
    renderTreeDiff(diffTrees(live, wanted), {
      full: flags.full,
      changedOnly: flags.changedOnly,
      palette,
    }),
  );
  console.log(
    renderRedundant(redundantGrants(wanted), { full: flags.full, palette }),
  );

  // Repositories nobody declares and no team reaches. Reported here rather than
  // planned: an undeclared repository is one to write down or archive, and
  // neither is a decision this tool should make.
  console.log(
    renderOrphans(
      orphanRepositories(
        live.repositories,
        desired.repositories?.map((r) => r.name),
        desired.teams.flatMap((t) => Object.keys(t.repositories ?? {})),
      ),
      palette,
    ),
  );
  return 0;
}

type RequireApproval = 'never' | 'destructive' | 'any-change';

interface Flags {
  manifest: string;
  yes: boolean;
  /** `true` = every destructive kind; a list = only those scopes. */
  allowDelete: boolean | DeleteScope[];
  requireApproval: RequireApproval;
  force: boolean;
  enableScim: boolean;
  full: boolean;
  changedOnly: boolean;
  live: boolean;
  byPerson: boolean;
  csv: boolean;
  color?: 'always' | 'never';
  /** Where `import` writes the definition; stdout when absent. */
  output?: string;
  /** `import` walks repositories: `true` = all of them, a list = only those. */
  repositories: boolean | string[];
  /** The command's positional argument, for the commands that take one. */
  positional?: string;
}

export function parseFlags(args: string[], command?: string): Flags {
  const flags: Flags = {
    manifest: 'github.out/manifest.json',
    yes: false,
    allowDelete: false,
    requireApproval: 'destructive',
    force: false,
    enableScim: false,
    full: false,
    changedOnly: false,
    live: false,
    byPerson: false,
    csv: false,
    repositories: false,
  };
  // `synth` takes a config path and `import` an org login; the rest take none.
  const positionalsAllowed = command === 'synth' || command === 'import' ? 1 : 0;
  let positionals = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--manifest': {
        const value = args[++i];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--manifest needs a path.');
        }
        flags.manifest = value;
        break;
      }
      case '--yes':
        flags.yes = true;
        break;
      case '--allow-delete':
        flags.allowDelete = true;
        break;
      case '--require-approval': {
        const value = args[++i];
        if (
          value !== 'never' &&
          value !== 'destructive' &&
          value !== 'any-change'
        ) {
          throw new Error(
            '--require-approval takes never, destructive, or any-change.',
          );
        }
        flags.requireApproval = value;
        break;
      }
      case '--force':
        flags.force = true;
        break;
      case '--enable-scim':
        flags.enableScim = true;
        break;
      case '--full':
        flags.full = true;
        break;
      case '--changed-only':
        flags.changedOnly = true;
        break;
      case '--live':
        flags.live = true;
        break;
      case '--color':
        flags.color = 'always';
        break;
      case '--no-color':
        flags.color = 'never';
        break;
      case '--by-person':
        flags.byPerson = true;
        break;
      case '--csv':
        flags.csv = true;
        flags.byPerson = true;
        break;
      case '--output': {
        const value = args[++i];
        if (value === undefined || value.startsWith('--')) {
          throw new Error('--output needs a path.');
        }
        flags.output = value;
        break;
      }
      case '--repositories':
        flags.repositories = true;
        break;
      default: {
        if (arg.startsWith('--allow-delete=')) {
          flags.allowDelete = parseDeleteScopes(
            arg.slice('--allow-delete='.length),
          );
          break;
        }
        if (arg.startsWith('--repositories=')) {
          const names = arg
            .slice('--repositories='.length)
            .split(',')
            .filter((name) => name !== '');
          if (names.length === 0) {
            throw new Error(
              '--repositories= needs at least one repository name.',
            );
          }
          flags.repositories = names;
          break;
        }
        // A misspelled flag must not silently change what an apply does.
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        if (++positionals > positionalsAllowed) {
          throw new Error(`Unexpected argument: ${arg}`);
        }
        flags.positional = arg;
        break;
      }
    }
  }
  return flags;
}

function parseDeleteScopes(value: string): DeleteScope[] {
  const scopes = value.split(',').filter((s) => s !== '');
  if (scopes.length === 0) {
    throw new Error(
      `--allow-delete= needs at least one scope (${Object.keys(DELETE_SCOPES).join(', ')}).`,
    );
  }
  for (const scope of scopes) {
    if (!(scope in DELETE_SCOPES)) {
      throw new Error(
        `Unknown --allow-delete scope "${scope}". ` +
          `Scopes: ${Object.keys(DELETE_SCOPES).join(', ')}.`,
      );
    }
  }
  return scopes as DeleteScope[];
}
