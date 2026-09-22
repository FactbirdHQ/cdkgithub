import { describe, expect, test } from 'bun:test';
import {
  App,
  maintain,
  Organization,
  push,
  role,
  Team,
  triage,
} from '../src/index.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

function org() {
  const app = new App();
  return new Organization(app, 'acme', { login: 'acme' });
}

describe('repository maintainership', () => {
  test('maintaining grants maintain', () => {
    const root = org();
    new Team(root, 'cloud', { maintains: ['nest', 'cloud-ingress'] });

    const state = synthesize(root.node.root);
    expect(state.teams[0]?.repositories).toEqual({
      nest: 'maintain',
      'cloud-ingress': 'maintain',
    });
    expect(state.teams[0]?.maintains).toEqual(['nest', 'cloud-ingress']);
  });

  test('a line in repositories overrides what maintaining grants', () => {
    const root = org();
    new Team(root, 'cloud', {
      maintains: ['nest'],
      repositories: { nest: 'push' },
    });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      nest: 'push',
    });
  });

  test('two teams claiming one repository fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', { maintains: ['nest'] });
    new Team(root, 'product', { maintains: ['nest'] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"nest" is maintained by both "cloud" and "product"/,
    );
  });

  test('the conflict is reported even across the tree', () => {
    const root = org();
    const parent = new Team(root, 'engineering', { maintains: ['fbctl'] });
    new Team(parent, 'cloud', { maintains: ['fbctl'] });

    expect(() => synthesize(root.node.root)).toThrow(/maintained by both/);
  });

  test('access may overlap freely; only maintainership is exclusive', () => {
    const root = org();
    new Team(root, 'cloud', { maintains: ['nest'] });
    new Team(root, 'support', { repositories: { nest: 'triage' } });

    const state = synthesize(root.node.root);
    expect(state.teams.find((t) => t.slug === 'cloud')?.repositories).toEqual({
      nest: 'maintain',
    });
    expect(state.teams.find((t) => t.slug === 'support')?.repositories).toEqual(
      {
        nest: 'triage',
      },
    );
  });

  test('declaring neither leaves the surface unmanaged', () => {
    const root = org();
    new Team(root, 'quiet', {});
    expect(synthesize(root.node.root).teams[0]?.repositories).toBeUndefined();
  });
});

describe('grants written one repository at a time', () => {
  test('the list form produces the same manifest as the map', () => {
    const a = org();
    new Team(a, 'cloud', { repositories: [push('nest'), maintain('fbctl')] });

    const b = org();
    new Team(b, 'cloud', { repositories: { nest: 'push', fbctl: 'maintain' } });

    expect(synthesize(a.node.root).teams[0]?.repositories).toEqual(
      synthesize(b.node.root).teams[0]?.repositories as Record<string, string>,
    );
  });

  test('a custom role is granted through role()', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [role('Merge Queue Jumper')('nest')],
    });
    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      nest: 'Merge Queue Jumper',
    });
  });

  test('the same repository granted twice fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [push('nest'), triage('fbctl'), maintain('nest')],
    });
    expect(() => synthesize(root.node.root)).toThrow(
      /grants "nest" twice, as "push" and "maintain"/,
    );
  });

  test('maintaining and granting the same repository is not a duplicate', () => {
    // `maintains` is merged first and `repositories` overrides it, which is the
    // documented way to hold a repository at something other than maintain.
    const root = org();
    new Team(root, 'cloud', {
      maintains: ['nest'],
      repositories: [push('nest')],
    });
    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      nest: 'push',
    });
  });
});

describe('granting a category', () => {
  /** A group declared elsewhere, the way a definition keeps its categories. */
  const SYSTEM_II = ['nest', 'nest-qa', 'nest-staging'] as const;

  test('a spread group grants every repository in it', () => {
    const root = org();
    new Team(root, 'support', { repositories: [triage(...SYSTEM_II)] });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      nest: 'triage',
      'nest-qa': 'triage',
      'nest-staging': 'triage',
    });
  });

  test('a group and a single grant sit in the same list', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [push('fbctl'), triage(...SYSTEM_II), maintain('tools')],
    });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      fbctl: 'push',
      nest: 'triage',
      'nest-qa': 'triage',
      'nest-staging': 'triage',
      tools: 'maintain',
    });
  });

  test('a repository in a group and named again is still a duplicate', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [triage(...SYSTEM_II), push('nest')],
    });

    expect(() => synthesize(root.node.root)).toThrow(
      /grants "nest" twice, as "triage" and "push"/,
    );
  });
});
