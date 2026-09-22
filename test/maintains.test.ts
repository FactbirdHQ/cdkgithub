import { describe, expect, test } from 'bun:test';
import { App, Organization, Team } from '../src/index.ts';
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
