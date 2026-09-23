import { describe, expect, test } from 'bun:test';
import {
  App,
  admin,
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
    new Team(root, 'cloud', {
      repositories: [maintain('nest', 'cloud-ingress')],
    });

    const state = synthesize(root.node.root);
    expect(state.teams[0]?.repositories).toEqual({
      nest: 'maintain',
      'cloud-ingress': 'maintain',
    });
  });

  test('the map form claims maintainership too', () => {
    // The claim is the permission, not the helper that wrote it.
    const root = org();
    new Team(root, 'cloud', { repositories: { nest: 'maintain' } });
    new Team(root, 'product', { repositories: [maintain('nest')] });

    expect(() => synthesize(root.node.root)).toThrow(/"nest" is owned by both/);
  });

  test('two teams claiming one repository fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', { repositories: [maintain('nest')] });
    new Team(root, 'product', { repositories: [maintain('nest')] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"nest" is owned by both "cloud" \("maintain"\) and "product"/,
    );
  });

  test('the conflict is reported even across the tree', () => {
    const root = org();
    const parent = new Team(root, 'engineering', {
      repositories: [maintain('fbctl')],
    });
    new Team(parent, 'cloud', { repositories: [maintain('fbctl')] });

    expect(() => synthesize(root.node.root)).toThrow(/is owned by both/);
  });

  test('access may overlap freely; only maintainership is exclusive', () => {
    const root = org();
    new Team(root, 'cloud', { repositories: [maintain('nest')] });
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

  test('maintaining and granting the same repository is still a duplicate', () => {
    // One repository takes one permission per team, whichever helper wrote it.
    const root = org();
    new Team(root, 'cloud', {
      repositories: [maintain('nest'), push('nest')],
    });
    expect(() => synthesize(root.node.root)).toThrow(
      /grants "nest" twice, as "maintain" and "push"/,
    );
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

describe('admin claims a repository too', () => {
  test('admin and maintain on one repository conflict', () => {
    // `admin` was the way around the rule: strictly stronger than `maintain`,
    // and unchecked, so the two could sit on different teams unnoticed.
    const root = org();
    new Team(root, 'iot-firmware', {
      repositories: [maintain('factbird-mini')],
    });
    new Team(root, 'hardware', { repositories: [admin('factbird-mini')] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"factbird-mini" is owned by both/,
    );
  });

  test('two admins conflict', () => {
    const root = org();
    new Team(root, 'one', { repositories: [admin('nest')] });
    new Team(root, 'two', { repositories: [admin('nest')] });

    expect(() => synthesize(root.node.root)).toThrow(/is owned by both/);
  });

  test('the message names which permission each team holds', () => {
    const root = org();
    new Team(root, 'cloud', { repositories: [admin('nest')] });
    new Team(root, 'product', { repositories: [maintain('nest')] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"cloud" \("admin"\) and "product" \("maintain"\)/,
    );
  });

  test('admin alongside a lesser permission is fine', () => {
    // Only ownership is exclusive. Reading and writing overlap freely.
    const root = org();
    new Team(root, 'cloud', { repositories: [admin('nest')] });
    new Team(root, 'support', { repositories: [triage('nest')] });
    new Team(root, 'product', { repositories: [push('nest')] });

    expect(() => synthesize(root.node.root)).not.toThrow();
  });
});
