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
