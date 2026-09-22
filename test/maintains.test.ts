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
    new Team(root, 'cloud', {
      repositories: [maintain('netcore', 'cloud-gateway')],
    });

    const state = synthesize(root.node.root);
    expect(state.teams[0]?.repositories).toEqual({
      netcore: 'maintain',
      'cloud-gateway': 'maintain',
    });
  });

  test('the map form claims maintainership too', () => {
    // The claim is the permission, not the helper that wrote it.
    const root = org();
    new Team(root, 'cloud', { repositories: { netcore: 'maintain' } });
    new Team(root, 'product', { repositories: [maintain('netcore')] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"netcore" is maintained by both/,
    );
  });

  test('two teams claiming one repository fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', { repositories: [maintain('netcore')] });
    new Team(root, 'product', { repositories: [maintain('netcore')] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"netcore" is maintained by both "cloud" and "product"/,
    );
  });

  test('the conflict is reported even across the tree', () => {
    const root = org();
    const parent = new Team(root, 'engineering', {
      repositories: [maintain('fctl')],
    });
    new Team(parent, 'cloud', { repositories: [maintain('fctl')] });

    expect(() => synthesize(root.node.root)).toThrow(/maintained by both/);
  });

  test('access may overlap freely; only maintainership is exclusive', () => {
    const root = org();
    new Team(root, 'cloud', { repositories: [maintain('netcore')] });
    new Team(root, 'support', { repositories: { netcore: 'triage' } });

    const state = synthesize(root.node.root);
    expect(state.teams.find((t) => t.slug === 'cloud')?.repositories).toEqual({
      netcore: 'maintain',
    });
    expect(state.teams.find((t) => t.slug === 'support')?.repositories).toEqual(
      {
        netcore: 'triage',
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
    new Team(a, 'cloud', { repositories: [push('netcore'), maintain('fctl')] });

    const b = org();
    new Team(b, 'cloud', { repositories: { netcore: 'push', fctl: 'maintain' } });

    expect(synthesize(a.node.root).teams[0]?.repositories).toEqual(
      synthesize(b.node.root).teams[0]?.repositories as Record<string, string>,
    );
  });

  test('a custom role is granted through role()', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [role('Merge Queue Jumper')('netcore')],
    });
    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      netcore: 'Merge Queue Jumper',
    });
  });

  test('the same repository granted twice fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [push('netcore'), triage('fctl'), maintain('netcore')],
    });
    expect(() => synthesize(root.node.root)).toThrow(
      /grants "netcore" twice, as "push" and "maintain"/,
    );
  });

  test('maintaining and granting the same repository is still a duplicate', () => {
    // One repository takes one permission per team, whichever helper wrote it.
    const root = org();
    new Team(root, 'cloud', {
      repositories: [maintain('netcore'), push('netcore')],
    });
    expect(() => synthesize(root.node.root)).toThrow(
      /grants "netcore" twice, as "maintain" and "push"/,
    );
  });
});

describe('granting a category', () => {
  /** A group declared elsewhere, the way a definition keeps its categories. */
  const SYSTEM_II = ['netcore', 'netcore-qa', 'netcore-staging'] as const;

  test('a spread group grants every repository in it', () => {
    const root = org();
    new Team(root, 'support', { repositories: [triage(...SYSTEM_II)] });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      netcore: 'triage',
      'netcore-qa': 'triage',
      'netcore-staging': 'triage',
    });
  });

  test('a group and a single grant sit in the same list', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [push('fctl'), triage(...SYSTEM_II), maintain('tools')],
    });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      fctl: 'push',
      netcore: 'triage',
      'netcore-qa': 'triage',
      'netcore-staging': 'triage',
      tools: 'maintain',
    });
  });

  test('a repository in a group and named again is still a duplicate', () => {
    const root = org();
    new Team(root, 'cloud', {
      repositories: [triage(...SYSTEM_II), push('netcore')],
    });

    expect(() => synthesize(root.node.root)).toThrow(
      /grants "netcore" twice, as "triage" and "push"/,
    );
  });
});
