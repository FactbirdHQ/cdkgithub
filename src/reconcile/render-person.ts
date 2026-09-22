/**
 * Render the per-person access view, before and after.
 *
 * The tree view is read to review a change. This one is read to answer who can
 * reach what, which is the question an access review asks, so it leads with the
 * person and names the team that grants each repository rather than leaving the
 * reader to trace it back up the tree.
 */

import type {
  PersonAccess,
  PersonDiff,
  ReachChange,
} from './access-by-person.ts';
import type { Palette } from './color.ts';
import { PLAIN } from './color.ts';

export interface RenderPersonOptions {
  /** List every repository each person holds, not only what differs. */
  readonly full?: boolean;
  /** Hide the people whose access is identical on both sides. */
  readonly changedOnly?: boolean;
  readonly palette?: Palette;
}

/** How many repositories are listed before the rest become a count. */
const SAMPLE = 12;

/** Render every person's access, with what changes marked up. */
export function renderAccessByPerson(
  people: PersonDiff[],
  options: RenderPersonOptions = {},
): string {
  const paint = options.palette ?? PLAIN;
  const shown = options.changedOnly
    ? people.filter((p) => !p.unchanged)
    : people;

  if (shown.length === 0) {
    return paint.muted('No one’s repository access changes.');
  }

  const lines: string[] = [];
  for (const person of shown) {
    lines.push(...renderPerson(person, options, paint));
    lines.push('');
  }

  const touched = people.filter((p) => !p.unchanged).length;
  lines.push(
    touched === 0
      ? paint.muted(
          `${people.length} ${people.length === 1 ? 'person' : 'people'}, none of whose access changes.`,
        )
      : `${touched} of ${people.length} ${people.length === 1 ? 'person' : 'people'} ` +
          `${touched === 1 ? 'sees' : 'see'} their repository access change.`,
  );
  return lines.join('\n');
}

function renderPerson(
  person: PersonDiff,
  options: RenderPersonOptions,
  paint: Palette,
): string[] {
  const before = person.before.repositories.size;
  const after = person.after.repositories.size;
  const delta =
    before === after
      ? `${after} ${after === 1 ? 'repo' : 'repos'}`
      : `${before} -> ${after} repos`;

  const heading = `${person.login}   (${delta})`;
  const lines = [person.unchanged ? paint.muted(heading) : heading];

  const indent = '    ';
  if (person.teamsJoined.length > 0) {
    lines.push(paint.added(`${indent}+ team ${person.teamsJoined.join(', ')}`));
  }
  if (person.teamsLeft.length > 0) {
    lines.push(paint.removed(`${indent}- team ${person.teamsLeft.join(', ')}`));
  }

  if (options.full) {
    lines.push(
      paint.muted(`${indent}teams: ${person.after.teams.join(', ') || 'none'}`),
    );
    lines.push(...listAll(person.after, indent, paint));
    return lines;
  }

  lines.push(...changeLines(person.gained, indent, 'added', '+', paint));
  lines.push(...changeLines(person.changed, indent, 'changed', '~', paint));
  lines.push(...changeLines(person.lost, indent, 'removed', '-', paint));
  return lines;
}

/** The gained, changed or lost repositories, sampled unless `--full`. */
function changeLines(
  changes: ReachChange[],
  indent: string,
  tone: keyof Palette,
  marker: string,
  paint: Palette,
): string[] {
  const rendered = changes.map((c) => {
    if (marker === '+') {
      return `${indent}+ ${c.repository} = "${c.to?.permission}"   via ${c.to?.through.join(', ')}`;
    }
    if (marker === '-') {
      return `${indent}- ${c.repository}   (had "${c.from?.permission}" via ${c.from?.through.join(', ')})`;
    }
    return `${indent}~ ${c.repository}: "${c.from?.permission}" -> "${c.to?.permission}"   via ${c.to?.through.join(', ')}`;
  });

  if (rendered.length <= SAMPLE) return rendered.map(paint[tone]);
  const hidden = rendered.length - SAMPLE;
  return [
    ...rendered.slice(0, SAMPLE).map(paint[tone]),
    paint.muted(`${indent}… and ${hidden} more   (--full to list)`),
  ];
}

/** Every repository a person holds after the change. */
function listAll(
  access: PersonAccess,
  indent: string,
  paint: Palette,
): string[] {
  if (access.repositories.size === 0) {
    return [paint.muted(`${indent}(no repositories)`)];
  }
  return [...access.repositories.values()].map((reach) =>
    paint.muted(
      `${indent}${reach.repository} = "${reach.permission}"   via ${reach.through.join(', ')}`,
    ),
  );
}

/** The same data as CSV, for an access review that wants a spreadsheet. */
export function renderAccessCsv(people: PersonDiff[]): string {
  const rows = ['login,repository,before,after,via'];
  for (const person of people) {
    const repositories = [
      ...new Set([
        ...person.before.repositories.keys(),
        ...person.after.repositories.keys(),
      ]),
    ].sort();

    for (const repository of repositories) {
      const from = person.before.repositories.get(repository);
      const to = person.after.repositories.get(repository);
      rows.push(
        [
          person.login,
          repository,
          from?.permission ?? '',
          to?.permission ?? '',
          quote((to ?? from)?.through.join(' ') ?? ''),
        ].join(','),
      );
    }
  }
  return rows.join('\n');
}

/** A CSV field, quoted only when it has to be. */
function quote(field: string): string {
  return /[",\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}
