import { describe, expect, test } from 'bun:test';
import { ANSI, choosePalette, PLAIN } from '../src/reconcile/color.ts';
import { renderTreeDiff } from '../src/reconcile/render-tree.ts';
import { diffTrees } from '../src/reconcile/tree-diff.ts';
import { desiredTree, readLiveTree } from '../src/reconcile/tree.ts';
import type { DesiredState, TeamManifest } from '../src/synth/manifest.ts';
import { FakeClient } from './fake-client.ts';

function team(slug: string, partial: Partial<TeamManifest> = {}): TeamManifest {
  return {
    slug,
    name: slug,
    privacy: 'closed',
    maintainers: [],
    members: [],
    repositories: {},
    ...partial,
  };
}

function manifest(teams: TeamManifest[]): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams };
}

describe('choosing a palette', () => {
  test('colors a terminal and leaves a pipe plain', () => {
    expect(choosePalette({ isTTY: true })).toBe(ANSI);
    expect(choosePalette({ isTTY: false })).toBe(PLAIN);
  });

  test('an explicit flag beats everything else', () => {
    expect(choosePalette({ flag: 'never', isTTY: true })).toBe(PLAIN);
    expect(
      choosePalette({ flag: 'always', isTTY: false, env: { NO_COLOR: '1' } }),
    ).toBe(ANSI);
  });

  test('NO_COLOR silences a terminal, and an empty one does not', () => {
    expect(choosePalette({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(PLAIN);
    expect(choosePalette({ isTTY: true, env: { NO_COLOR: '' } })).toBe(ANSI);
  });

  test('NO_COLOR outranks FORCE_COLOR', () => {
    const env = { NO_COLOR: '1', FORCE_COLOR: '1' };
    expect(choosePalette({ isTTY: false, env })).toBe(PLAIN);
  });

  test('FORCE_COLOR colors a pipe, and FORCE_COLOR=0 does not', () => {
    expect(choosePalette({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(
      ANSI,
    );
    expect(choosePalette({ isTTY: false, env: { FORCE_COLOR: '0' } })).toBe(
      PLAIN,
    );
  });

  test('a dumb terminal is not a terminal', () => {
    expect(choosePalette({ isTTY: true, env: { TERM: 'dumb' } })).toBe(PLAIN);
  });
});

describe('coloring the diff', () => {
  /** A diff holding one of each mark, plus a grant and a member on both sides. */
  async function sampleDiff() {
    const client = new FakeClient({
      teams: [
        {
          id: 1,
          slug: 'cloud',
          name: 'cloud',
          description: null,
          privacy: 'closed',
          parentSlug: null,
        },
        {
          id: 2,
          slug: 'gone',
          name: 'gone',
          description: null,
          privacy: 'closed',
          parentSlug: null,
        },
        {
          id: 3,
          slug: 'quiet',
          name: 'quiet',
          description: null,
          privacy: 'closed',
          parentSlug: null,
        },
      ],
      teamMembers: { cloud: [{ login: 'leaver', role: 'member' }] },
      teamRepositories: { cloud: [{ name: 'old', roleName: 'read' }] },
    });
    const live = await readLiveTree(client, 'acme');
    return diffTrees(
      live,
      desiredTree(
        manifest([
          team('cloud', {
            members: ['joiner'],
            repositories: { fresh: 'push' },
          }),
          team('quiet'),
          team('added'),
        ]),
      ),
    );
  }

  test('the plain palette is the default and emits no escapes', async () => {
    const output = renderTreeDiff(await sampleDiff());
    expect(output).not.toContain('\x1b[');
  });

  test('each mark takes its own color', async () => {
    const lines = renderTreeDiff(await sampleDiff(), { palette: ANSI }).split(
      '\n',
    );
    const find = (needle: string) =>
      lines.find((l) => l.includes(needle)) ?? '';

    expect(find('team added')).toStartWith('\x1b[32m'); // green
    expect(find('team gone')).toStartWith('\x1b[31m'); // red
    expect(find('team cloud')).toStartWith('\x1b[33m'); // yellow
    expect(find('team quiet')).toStartWith('\x1b[2m'); // dim
  });

  test('a changed team holds both green and red beneath it', async () => {
    const lines = renderTreeDiff(await sampleDiff(), { palette: ANSI }).split(
      '\n',
    );
    const find = (needle: string) =>
      lines.find((l) => l.includes(needle)) ?? '';

    expect(find('repo fresh')).toStartWith('\x1b[32m');
    expect(find('repo old')).toStartWith('\x1b[31m');
    expect(find('member joiner')).toStartWith('\x1b[32m');
    expect(find('member leaver')).toStartWith('\x1b[31m');
  });

  test('every colored line closes the escape it opens', async () => {
    for (const line of renderTreeDiff(await sampleDiff(), {
      palette: ANSI,
    }).split('\n')) {
      const opens = (line.match(/\x1b\[(?!0m)/g) ?? []).length;
      const closes = (line.match(/\x1b\[0m/g) ?? []).length;
      expect(closes).toBe(opens);
    }
  });

  test('color changes nothing but the escapes', async () => {
    const diff = await sampleDiff();
    const colored = renderTreeDiff(diff, { palette: ANSI });
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR codes
    const stripped = colored.replace(/\x1b\[[0-9]*m/g, '');
    expect(stripped).toBe(renderTreeDiff(diff));
  });
});
