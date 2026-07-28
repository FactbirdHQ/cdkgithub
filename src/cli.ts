import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OctokitGitHubClient } from './github/client.ts';
import { resolveToken } from './github/token.ts';
import { apply } from './reconcile/applier.ts';
import { plan } from './reconcile/planner.ts';
import { renderPlan } from './reconcile/render.ts';
import type { DesiredState } from './synth/manifest.ts';

const USAGE = `cdkgithub — define GitHub org team structure as code

Usage:
  cdkgithub synth <config.ts>      Run a definition and write github.out/manifest.json
  cdkgithub plan  [options]        Diff the manifest against the live org (read-only)
  cdkgithub apply [options]        Reconcile the live org to match the manifest

Options:
  --manifest <path>   Manifest to read for plan/apply (default: github.out/manifest.json)
  --yes               Actually execute changes (apply). Without it, apply is a dry run.
  --allow-delete      Permit deleting teams that are absent from the manifest.
  --enable-scim       Perform Entra ID (SCIM) external-group linking.

Auth: uses GITHUB_TOKEN/GH_TOKEN, else falls back to \`gh auth token\`.`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  switch (command) {
    case 'synth':
      return synthCommand(rest[0]);
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
  const live = await client.listTeams(desired.org);
  const changes = plan(desired, live);
  console.log(`Plan for organization "${desired.org}":\n`);
  console.log(renderPlan(changes));
  return 0;
}

async function applyCommand(flags: Flags): Promise<number> {
  const desired = readManifest(flags.manifest);
  const client = new OctokitGitHubClient(resolveToken());
  const live = await client.listTeams(desired.org);
  const changes = plan(desired, live);

  console.log(`Plan for organization "${desired.org}":\n`);
  console.log(renderPlan(changes));
  console.log('');

  if (!flags.yes) {
    console.log('Dry run. Re-run with --yes to apply these changes.');
    return 0;
  }

  const result = await apply(client, desired.org, changes, live, {
    allowDelete: flags.allowDelete,
    enableScim: flags.enableScim,
    onProgress: (m) => console.log(`  ${m}`),
  });

  console.log(
    `\nApplied: ${result.created} created, ${result.updated} updated, ` +
      `${result.linked} linked, ${result.deleted} deleted.`,
  );
  for (const s of result.skipped) console.log(`  skipped: ${s}`);
  return 0;
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

interface Flags {
  manifest: string;
  yes: boolean;
  allowDelete: boolean;
  enableScim: boolean;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {
    manifest: 'github.out/manifest.json',
    yes: false,
    allowDelete: false,
    enableScim: false,
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
    }
  }
  return flags;
}
