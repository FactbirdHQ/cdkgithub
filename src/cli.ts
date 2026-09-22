import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OctokitGitHubClient } from './github/client.ts';
import { resolveToken } from './github/token.ts';
import { apply } from './reconcile/applier.ts';
import { readLiveState } from './reconcile/live.ts';
import { unmanagedRoleAssignments } from './reconcile/plan-org-roles.ts';
import { plan } from './reconcile/planner.ts';
import { diffAccessByPerson } from './reconcile/access-by-person.ts';
import { choosePalette } from './reconcile/color.ts';
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
import type { DesiredState } from './synth/manifest.ts';
import { collectWarnings } from './synth/warnings.ts';

const USAGE = `cdkgithub — define GitHub org team structure as code

Usage:
  cdkgithub synth <config.ts>      Run a definition and write github.out/manifest.json
  cdkgithub diff  [options]        Compare the live org tree against the manifest
  cdkgithub plan  [options]        Diff the manifest against the live org (read-only)
  cdkgithub apply [options]        Reconcile the live org to match the manifest

Options:
  --manifest <path>   Manifest to read for plan/apply (default: github.out/manifest.json)
  --yes               Actually execute changes (apply). Without it, apply is a dry run.
  --allow-delete      Permit deleting resources absent from the manifest (teams,
                      rulesets, code security configurations, custom properties).
  --enable-scim       Perform Entra ID (SCIM) external-group linking.
  --full              Expand every team, listing every grant rather than a sample.
  --changed-only      Hide teams whose whole subtree matches (diff).
  --live              Print the live org tree and stop, without comparing (diff).
  --by-person         Pivot the diff onto people: the repositories each one can
                      reach, before and after, and the team granting each.
  --csv               Emit --by-person as CSV, one row per person per repository.
  --color / --no-color  Force color on or off. The default colors a terminal and
                      leaves a pipe or a file plain; NO_COLOR is honoured.

Auth: uses GITHUB_TOKEN/GH_TOKEN, else falls back to \`gh auth token\`. Managing
teams needs org-admin scope; the governance surfaces additionally need admin:org,
and code security configurations need the org to have those features available.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'synth':
      return synthCommand(rest[0]);
    case 'diff':
      return diffCommand(flags);
    case 'plan':
      return planCommand(flags);
    case 'apply':
      return applyCommand(flags);
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
  return 0;
}

async function planCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const client = new OctokitGitHubClient(resolveToken());
  const live = await readLiveState(client, desired);
  const changes = plan(desired, live);
  printWarnings(desired);
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
  console.log(`Plan for ${describeOwner(desired)}:\n`);
  console.log(renderPlan(changes));
  console.log('');

  if (!flags.yes) {
    console.log('Dry run. Re-run with --yes to apply these changes.');
    return 0;
  }

  const result = await apply(client, desired.owner, changes, live, {
    allowDelete: flags.allowDelete,
    enableScim: flags.enableScim,
    onProgress: (m) => console.log(`  ${m}`),
  });

  console.log(
    `\nApplied: ${result.created} created, ${result.updated} updated, ` +
      `${result.linked} linked, ${result.deleted} deleted, ` +
      `${result.governance} governance change${result.governance === 1 ? '' : 's'}.`,
  );
  for (const s of result.skipped) console.log(`  skipped: ${s}`);
  return 0;
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

function readManifest(path: string): DesiredState {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DesiredState;
  } catch {
    throw new Error(
      `Could not read manifest at "${path}". Run \`cdkgithub synth\` first.`,
    );
  }
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
  const live = await readLiveTree(client, desired.owner, desired.ownerType);
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
  const wanted = desiredTree(desired, live.customRoles);

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
  return 0;
}

interface Flags {
  manifest: string;
  yes: boolean;
  allowDelete: boolean;
  enableScim: boolean;
  full: boolean;
  changedOnly: boolean;
  live: boolean;
  byPerson: boolean;
  csv: boolean;
  color?: 'always' | 'never';
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    manifest: 'github.out/manifest.json',
    yes: false,
    allowDelete: false,
    enableScim: false,
    full: false,
    changedOnly: false,
    live: false,
    byPerson: false,
    csv: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--manifest':
        flags.manifest = args[++i] ?? flags.manifest;
        break;
      case '--yes':
        flags.yes = true;
        break;
      case '--allow-delete':
        flags.allowDelete = true;
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
    }
  }
  return flags;
}
