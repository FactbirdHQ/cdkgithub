/**
 * Render the per-person access view, before and after.
 *
 * The tree view is read to review a change. This one is read to answer who can
 * reach what, which is the question an access review asks, so it leads with the
 * person and names the team that grants each repository rather than leaving the
 * reader to trace it back up the tree.
 */

import type {
  PersonDiff,
  ReachChange,
  RepositoryReach,
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
    lines.push(...listAll(person, indent, paint));
    return lines;
  }

  lines.push(...changeLines(person.gained, indent, 'added', '+', paint));
  lines.push(...changeLines(person.changed, indent, 'changed', '~', paint));
  lines.push(...changeLines(person.lost, indent, 'removed', '-', paint));
  return lines;
}

/**
 * Split off the repositories an organization role reaches wholesale.
 *
 * A role carrying a base permission reaches every repository, so listing it
 * per repository buries the handful of grants a reader is looking for under
 * two hundred identical lines. The role is stated once and the exceptions,
 * where a team grants more than it, stay listed one by one.
 *
 * A single repository is left where it is: a summary of one says less than the
 * line it replaces.
 */
function collapseBlanket<
  T extends { readonly repository: string; readonly to?: RepositoryReach },
>(
  entries: T[],
): {
  summaries: Array<{ role: string; permission: string; count: number }>;
  rest: T[];
} {
  const grouped = new Map<string, T[]>();
  const rest: T[] = [];
  for (const entry of entries) {
    const role = entry.to?.blanket;
    if (!role) {
      rest.push(entry);
      continue;
    }
    grouped.set(role, [...(grouped.get(role) ?? []), entry]);
  }

  const summaries: Array<{ role: string; permission: string; count: number }> =
    [];
  for (const [role, group] of [...grouped].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (group.length === 1) {
      rest.push(...group);
      continue;
    }
    summaries.push({
      role,
      permission: group[0]?.to?.permission ?? '',
      count: group.length,
    });
  }
  return { summaries, rest: rest.sort(byRepository) };
}

function byRepository(
  a: { readonly repository?: string },
  b: { readonly repository?: string },
): number {
  return (a.repository ?? '').localeCompare(b.repository ?? '');
}

/** The gained, changed or lost repositories, sampled unless `--full`. */
function changeLines(
  changes: ReachChange[],
  indent: string,
  tone: keyof Palette,
  marker: string,
  paint: Palette,
): string[] {
  // Only a gain or a change can come from a role; losing one is losing the
  // assignment, which the role's own summary already says.
  const { summaries, rest } =
    marker === '-'
      ? { summaries: [], rest: changes }
      : collapseBlanket(changes);

  const summaryLines = summaries.map((s) =>
    paint[tone](
      `${indent}${marker} all ${s.count} repositories = "${s.permission}"   via ${s.role} (organization role)`,
    ),
  );

  const rendered = rest.map((c) => {
    if (marker === '+') {
      return `${indent}+ ${c.repository} = "${c.to?.permission}"   via ${c.to?.through.join(', ')}`;
    }
    if (marker === '-') {
      return `${indent}- ${c.repository}   (had "${c.from?.permission}" via ${c.from?.through.join(', ')})`;
    }
    return `${indent}~ ${c.repository}: "${c.from?.permission}" -> "${c.to?.permission}"   via ${c.to?.through.join(', ')}`;
  });

  if (rendered.length <= SAMPLE) {
    return [...summaryLines, ...rendered.map(paint[tone])];
  }
  const hidden = rendered.length - SAMPLE;
  return [
    ...summaryLines,
    ...rendered.slice(0, SAMPLE).map(paint[tone]),
    paint.muted(`${indent}… and ${hidden} more   (--full to list)`),
  ];
}

/**
 * Every repository either side gives this person, each marked with what happens
 * to it.
 *
 * `--full` widens the list; it does not turn the diff back into a listing. A
 * repository arriving is `+` whether or not the other four hundred lines around
 * it are unchanged, so the marks are the same ones the sampled view uses and
 * only a repository that genuinely stays put is left plain.
 */
function listAll(person: PersonDiff, indent: string, paint: Palette): string[] {
  const { before, after } = person;
  const repositories = [
    ...new Set([...before.repositories.keys(), ...after.repositories.keys()]),
  ].sort();

  if (repositories.length === 0) {
    return [paint.muted(`${indent}(no repositories)`)];
  }

  const entries = repositories.map((repository) => ({
    repository,
    from: before.repositories.get(repository),
    to: after.repositories.get(repository),
  }));
  const { summaries, rest } = collapseBlanket(entries);

  // The role's line takes the tone of what it does to the reader's access: a
  // role that was not there before is a gain, one that was is unchanged.
  const summaryLines = summaries.map((s) => {
    const gained = entries.every((e) => e.to?.blanket !== s.role || !e.from);
    const tone: keyof Palette = gained ? 'added' : 'muted';
    const marker = gained ? '+' : ' ';
    return paint[tone](
      `${indent}${marker} all ${s.count} repositories = "${s.permission}"   via ${s.role} (organization role)`,
    );
  });

  return [
    ...summaryLines,
    ...rest.map(({ repository, from, to }) => {
      if (!from && to) {
        return paint.added(
          `${indent}+ ${repository} = "${to.permission}"   via ${to.through.join(', ')}`,
        );
      }
      if (from && !to) {
        return paint.removed(
          `${indent}- ${repository}   (had "${from.permission}" via ${from.through.join(', ')})`,
        );
      }
      if (from && to && from.permission !== to.permission) {
        return paint.changed(
          `${indent}~ ${repository}: "${from.permission}" -> "${to.permission}"   via ${to.through.join(', ')}`,
        );
      }
      const held = (to ?? from) as RepositoryReach;
      return paint.muted(
        `${indent}  ${repository} = "${held.permission}"   via ${held.through.join(', ')}`,
      );
    }),
  ];
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
