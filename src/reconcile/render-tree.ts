/**
 * Render an organization tree, and the diff between two of them, as text.
 *
 * The change mark sits in a fixed left gutter so the tree keeps its shape down
 * the page: indentation says where a team is, the gutter says what happens to
 * it. An unchanged team is one line, a changed one expands into what differs,
 * and an added or removed team is summarised rather than listed in full.
 *
 * Color carries the same three marks a second time, so the eye finds a change
 * before it reads one. It is applied per line rather than per team: under a team
 * that differs, a grant being added is green and a member leaving is red, which
 * is the distinction worth seeing there.
 */

import type { RepositoryAccess } from '../synth/manifest.ts';
import type { Palette } from './color.ts';
import { PLAIN } from './color.ts';
import type { OrgTree, TeamNode } from './tree.ts';
import type { OrgDiff, TeamDiff } from './tree-diff.ts';

export interface RenderTreeOptions {
  /** Expand every team in full, listing every grant rather than a sample. */
  readonly full?: boolean;
  /** Hide teams whose whole subtree is unchanged. */
  readonly changedOnly?: boolean;
  /** How to decorate the output. Defaults to no decoration at all. */
  readonly palette?: Palette;
}

const INDENT = '  ';
const BLANK_GUTTER = '  ';
const GUTTER: Record<TeamDiff['mark'], string> = {
  unchanged: '  ',
  changed: '~ ',
  added: '+ ',
  removed: '- ',
};

/**
 * How many of a team's differing grants are listed before the rest become a
 * count. A repository list is the one part of a team that runs to the hundreds,
 * and one team's regenerated list would otherwise bury every other team in the
 * tree. `--full` prints them all.
 */
const GRANT_SAMPLE = 8;

/** Render one tree on its own, the way `diff --live` prints the live org. */
export function renderTree(
  tree: OrgTree,
  options: RenderTreeOptions = {},
): string {
  const paint = options.palette ?? PLAIN;
  const lines = [`organization ${tree.owner}`];
  const walk = (node: TeamNode, depth: number) => {
    const pad = INDENT.repeat(depth + 1);
    lines.push(`${pad}team ${node.slug}${paint.muted(summary(node))}`);
    for (const line of detailLines(node)) {
      lines.push(paint.muted(`${pad}${INDENT}${line}`));
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of tree.roots) walk(root, 0);

  if (tree.roots.length === 0) lines.push(paint.muted(`${INDENT}(no teams)`));
  return lines.join('\n');
}

/** Render the comparison of a live tree against a desired one. */
export function renderTreeDiff(
  diff: OrgDiff,
  options: RenderTreeOptions = {},
): string {
  const paint = options.palette ?? PLAIN;
  // A team's own line takes the color of its mark; the lines beneath it are
  // painted one at a time, because a team that differs holds both additions and
  // removals and one color over the lot would hide which is which.
  const byMark: Record<TeamDiff['mark'], (text: string) => string> = {
    unchanged: paint.muted,
    changed: paint.changed,
    added: paint.added,
    removed: paint.removed,
  };

  const lines = [`${BLANK_GUTTER}organization ${diff.owner}`];

  const walk = (team: TeamDiff, depth: number) => {
    if (options.changedOnly && !subtreeChanged(team)) return;

    const pad = INDENT.repeat(depth + 1);
    lines.push(
      byMark[team.mark](
        `${GUTTER[team.mark]}${pad}team ${team.slug}${renamedFrom(team)}${headline(team)}`,
      ),
    );
    for (const line of teamDetail(team, options)) {
      lines.push(
        paint[line.tone](`${BLANK_GUTTER}${pad}${INDENT}${line.text}`),
      );
    }
    for (const child of team.children) walk(child, depth + 1);
  };

  for (const root of diff.roots) walk(root, 0);

  const { added, removed, changed } = diff.counts;
  // A count of none is muted whatever it counts, so the colors mark the work
  // there is rather than drawing the eye to a zero.
  const tally = (count: number, text: string, tone: keyof Palette) =>
    count === 0 ? paint.muted(text) : paint[tone](text);

  lines.push('');
  lines.push(
    added + removed + changed === 0
      ? paint.muted(
          'No differences. The organization tree matches the definition.',
        )
      : `${tally(changed, `${changed} team${changed === 1 ? '' : 's'} to change`, 'changed')}, ` +
          `${tally(added, `${added} to add`, 'added')}, ` +
          `${tally(removed, `${removed} to remove`, 'removed')}.`,
  );
  return lines.join('\n');
}

/** Whether a team or anything beneath it differs. */
function subtreeChanged(team: TeamDiff): boolean {
  return team.mark !== 'unchanged' || team.children.some(subtreeChanged);
}

/** The parenthetical after a team's name: what it holds, in one count each. */
function headline(team: TeamDiff): string {
  return team.mark === 'changed' ? '' : summary(team.node);
}

/**
 * The live name a changed team is being renamed from.
 *
 * Put on the team's own line rather than left to the `slug:` property below it,
 * because the tree is read by team name and a renamed team is otherwise
 * indistinguishable from one that simply changed.
 */
function renamedFrom(team: TeamDiff): string {
  const from = team.live?.slug;
  return from && from !== team.slug ? `   (was ${from})` : '';
}

function summary(node: TeamNode): string {
  const parts: string[] = [];
  const repos = Object.keys(node.effectiveRepositories).length;
  const people = node.maintainers.length + node.members.length;
  if (repos > 0) parts.push(`${repos} repo${repos === 1 ? '' : 's'}`);
  if (people > 0) parts.push(`${people} ${people === 1 ? 'person' : 'people'}`);
  return parts.length > 0 ? `   (${parts.join(', ')})` : '';
}

/** A line beneath a team, and which of the palette's colors it takes. */
interface DetailLine {
  readonly text: string;
  readonly tone: keyof Palette;
}

/** The lines beneath a team in the diff. */
function teamDetail(team: TeamDiff, options: RenderTreeOptions): DetailLine[] {
  if (team.mark !== 'changed') {
    return options.full
      ? detailLines(team.node).map((text) => ({ text, tone: 'muted' as const }))
      : [];
  }

  const lines: DetailLine[] = [];
  // The slug change is already on the team's own line as `(was …)`.
  for (const p of team.properties) {
    if (p.property === 'slug') continue;
    lines.push({
      text: `${p.property}: ${quote(p.from)} -> ${quote(p.to)}`,
      tone: 'changed',
    });
  }

  const grants = team.grants.map<DetailLine>((g) => {
    if (g.from === undefined) {
      return { text: `+ repo ${g.repository} = "${g.to}"`, tone: 'added' };
    }
    if (g.to === undefined) {
      return {
        text: `- repo ${g.repository}   (was "${g.from}")`,
        tone: 'removed',
      };
    }
    return {
      text: `~ repo ${g.repository}: "${g.from}" -> "${g.to}"`,
      tone: 'changed',
    };
  });
  lines.push(...sample(grants, options, 'grant'));

  if (team.rosterOwnedByIdp) {
    lines.push({
      text: 'roster not compared: Entra owns it through the external group',
      tone: 'muted',
    });
  }
  const roster: DetailLine[] = [];
  for (const r of team.rosters) {
    for (const user of r.added) {
      roster.push({ text: `+ ${r.role} ${user}`, tone: 'added' });
    }
    for (const user of r.removed) {
      roster.push({ text: `- ${r.role} ${user}`, tone: 'removed' });
    }
  }
  lines.push(...sample(roster, options, 'roster change'));

  return lines;
}

/** The first {@link GRANT_SAMPLE} lines, with the remainder as a count. */
function sample(
  lines: DetailLine[],
  options: RenderTreeOptions,
  noun: string,
): DetailLine[] {
  if (options.full || lines.length <= GRANT_SAMPLE) return lines;
  const hidden = lines.length - GRANT_SAMPLE;
  return [
    ...lines.slice(0, GRANT_SAMPLE),
    {
      text: `… and ${hidden} more ${noun}${hidden === 1 ? '' : 's'}   (--full to list)`,
      tone: 'muted',
    },
  ];
}

/** A team's own contents, for `--full` and for rendering a single tree. */
function detailLines(node: TeamNode): string[] {
  const lines: string[] = [];
  if (node.description) lines.push(`description = "${node.description}"`);
  lines.push(`privacy = "${node.privacy}"`);
  for (const user of node.maintainers) lines.push(`maintainer ${user}`);
  for (const user of node.members) lines.push(`member ${user}`);
  lines.push(...grantLines(node.repositories));
  return lines;
}

function grantLines(access: RepositoryAccess): string[] {
  return Object.keys(access)
    .sort()
    .map((repo) => `repo ${repo} = "${access[repo]}"`);
}

function quote(value: string | null): string {
  return value === null || value === '' ? 'none' : `"${value}"`;
}

/** The trailing report of declarations an ancestor already covers. */
export function renderRedundant(
  redundant: Array<{ slug: string; repositories: string[] }>,
  options: RenderTreeOptions = {},
): string {
  if (redundant.length === 0) return '';

  const paint = options.palette ?? PLAIN;
  const total = redundant.reduce((n, r) => n + r.repositories.length, 0);
  const lines = [
    '',
    `${total} redundant grant${total === 1 ? '' : 's'}: a parent team already ` +
      'grants the same access or more, so deleting these lines changes nothing.',
    '',
  ];
  for (const entry of redundant) {
    const shown = options.full
      ? entry.repositories
      : entry.repositories.slice(0, GRANT_SAMPLE);
    const rest = entry.repositories.length - shown.length;
    const tail = rest > 0 ? `, … and ${rest} more` : '';
    // The team is what someone acts on here; the repository list is the detail.
    lines.push(`  ${entry.slug}: ${paint.muted(`${shown.join(', ')}${tail}`)}`);
  }
  if (!options.full) lines.push('', paint.muted('  (--full to list them all)'));
  return lines.join('\n');
}
