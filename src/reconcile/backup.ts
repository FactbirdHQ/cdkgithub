import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DesiredState } from '../synth/manifest.ts';
import type { ApplyRecord } from './applier.ts';
import type { Change } from './changes.ts';
import type { LiveState } from './live.ts';
import { rollbackManifest } from './rollback.ts';

export interface Backup {
  /** Directory the backup was written to. */
  readonly dir: string;
  /** Append one journal entry; called by `apply` after every attempted change. */
  readonly journal: (record: ApplyRecord) => void;
}

/**
 * Persist everything needed to understand and undo an apply, before it writes.
 *
 * Three files, all from data the run already holds: `live-state.json` is the
 * organization as it stood, `rollback-manifest.json` is a manifest that puts
 * the team structure back (`apply --manifest` it to revert), and `plan.json`
 * is the change list about to execute. `journal.jsonl` then grows one line per
 * attempted change, so an aborted run says exactly where it stopped.
 */
export function writeBackup(outdir: string, desired: DesiredState, live: LiveState, changes: Change[]): Backup {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(outdir, 'backups', stamp);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'live-state.json'), `${JSON.stringify(serializeLiveState(live), null, 2)}\n`);
  writeFileSync(join(dir, 'rollback-manifest.json'), `${JSON.stringify(rollbackManifest(desired, live), null, 2)}\n`);
  writeFileSync(join(dir, 'plan.json'), `${JSON.stringify(changes, null, 2)}\n`);

  const journalPath = join(dir, 'journal.jsonl');
  return {
    dir,
    journal: (record) => {
      appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    },
  };
}

/** The live state with its Maps as plain objects, so JSON keeps them. */
function serializeLiveState(live: LiveState): Record<string, unknown> {
  return {
    ...live,
    teamRepositories: live.teamRepositories ? Object.fromEntries(live.teamRepositories) : undefined,
    teamMembers: live.teamMembers ? Object.fromEntries(live.teamMembers) : undefined,
  };
}
