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
    new Team(root, 'cloud', { maintains: ['netcore', 'cloud-gateway'] });

    const state = synthesize(root.node.root);
    expect(state.teams[0]?.repositories).toEqual({
      netcore: 'maintain',
      'cloud-gateway': 'maintain',
    });
    expect(state.teams[0]?.maintains).toEqual(['netcore', 'cloud-gateway']);
  });

  test('a line in repositories overrides what maintaining grants', () => {
    const root = org();
    new Team(root, 'cloud', {
      maintains: ['netcore'],
      repositories: { netcore: 'push' },
    });

    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      netcore: 'push',
    });
  });

  test('two teams claiming one repository fails synthesis', () => {
    const root = org();
    new Team(root, 'cloud', { maintains: ['netcore'] });
    new Team(root, 'product', { maintains: ['netcore'] });

    expect(() => synthesize(root.node.root)).toThrow(
      /"netcore" is maintained by both "cloud" and "product"/,
    );
  });

  test('the conflict is reported even across the tree', () => {
    const root = org();
    const parent = new Team(root, 'engineering', { maintains: ['fctl'] });
    new Team(parent, 'cloud', { maintains: ['fctl'] });

    expect(() => synthesize(root.node.root)).toThrow(/maintained by both/);
  });

  test('access may overlap freely; only maintainership is exclusive', () => {
    const root = org();
    new Team(root, 'cloud', { maintains: ['netcore'] });
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

  test('maintaining and granting the same repository is not a duplicate', () => {
    // `maintains` is merged first and `repositories` overrides it, which is the
    // documented way to hold a repository at something other than maintain.
    const root = org();
    new Team(root, 'cloud', {
      maintains: ['netcore'],
      repositories: [push('netcore')],
    });
    expect(synthesize(root.node.root).teams[0]?.repositories).toEqual({
      netcore: 'push',
    });
  });
});
