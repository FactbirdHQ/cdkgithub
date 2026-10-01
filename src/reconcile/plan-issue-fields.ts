/**
 * Diff the organization's issue fields.
 *
 * Identity is the name. GitHub addresses a field by id, so an update carries
 * the live field it was diffed against, and the client keeps each option's id
 * by matching names. A renamed option is therefore a new option, and the old
 * one's values go with it.
 *
 * The plan compares options in order, because GitHub shows them in that order.
 * It compares the other fields only when the definition declares them.
 */

import type { LiveIssueField } from '../github/client.ts';
import type {
  IssueFieldManifest,
  IssueFieldOptionManifest,
} from '../synth/manifest.ts';
import type { Change, FieldChange } from './changes.ts';
import type { LiveState } from './live.ts';
import { matchesSubset } from './subset.ts';

export function planIssueFields(
  desired: IssueFieldManifest[] | undefined,
  live: LiveState,
): Change[] {
  if (!desired) return [];

  const liveByName = new Map((live.issueFields ?? []).map((f) => [f.name, f]));
  const declared = new Set(desired.map((f) => f.name));
  const changes: Change[] = [];

  for (const field of desired) {
    const current = liveByName.get(field.name);
    if (!current) {
      changes.push({ kind: 'create-issue-field', field });
      continue;
    }
    if (current.dataType !== field.dataType) {
      throw new Error(
        `Issue field "${field.name}" is a ${current.dataType} field on GitHub, ` +
          `and the definition declares ${field.dataType}. GitHub cannot change ` +
          'a field\'s type in place. To replace it, remove the field from the ' +
          'definition, apply with --allow-delete=issue-fields (which clears its ' +
          'value from every issue), then declare it again.',
      );
    }
    const fields = diff(field, current);
    if (fields.length > 0) {
      changes.push({ kind: 'update-issue-field', live: current, field, fields });
    }
  }

  for (const current of liveByName.values()) {
    if (declared.has(current.name)) continue;
    changes.push({ kind: 'delete-issue-field', live: current });
  }

  return changes;
}

function diff(desired: IssueFieldManifest, live: LiveIssueField): FieldChange[] {
  const fields: FieldChange[] = [];

  for (const key of ['description', 'visibility'] as const) {
    const value = desired[key];
    if (value !== undefined && !matchesSubset(value, live[key])) {
      fields.push({ field: key, from: live[key] ?? null, to: value });
    }
  }

  if (desired.options) {
    const wanted = desired.options.map(describeOption);
    const held = (live.options ?? []).map(describeOption);
    if (wanted.join('\n') !== held.join('\n')) {
      fields.push({ field: 'options', from: held, to: wanted });
    }
  }

  return fields;
}

/** An option as one comparable string: name, color, then description if any. */
function describeOption(option: IssueFieldOptionManifest): string {
  const color = option.color ?? 'gray';
  return option.description
    ? `${option.name} [${color}] ${option.description}`
    : `${option.name} [${color}]`;
}
