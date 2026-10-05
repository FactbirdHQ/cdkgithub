import { describe, expect, test } from 'bun:test';

import {
  ActionsPolicy,
  App,
  CodeSecurityConfiguration,
  CustomProperty,
  Organization,
  Ruleset,
  Team,
} from '../src/index.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

describe('synthesize', () => {
  test('resolves nesting, slugs, defaults, and external groups', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const eng = new Team(org, 'engineering', {
      description: 'All engineers',
      externalGroup: { name: 'GH-Engineering' },
    });
    new Team(eng, 'platform', { name: 'Platform Team' });

    const state = synthesize(app);

    expect(state.owner).toBe('acme');
    expect(state.ownerType).toBe('organization');
    const bySlug = Object.fromEntries(state.teams.map((t) => [t.slug, t]));

    // slug derivation from a spaced name
    expect(bySlug['platform-team']).toBeDefined();
    // privacy defaults to "closed"
    expect(bySlug.engineering!.privacy).toBe('closed');
    // nested team resolves its parent slug
    expect(bySlug['platform-team']!.parentSlug).toBe('engineering');
    // external group is carried through
    expect(bySlug.engineering!.externalGroup).toEqual({
      name: 'GH-Engineering',
      id: undefined,
    });
  });

  test('orders parents before children', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const parent = new Team(org, 'parent');
    const child = new Team(parent, 'child');
    new Team(child, 'grandchild');

    const slugs = synthesize(app).teams.map((t) => t.slug);
    expect(slugs.indexOf('parent')).toBeLessThan(slugs.indexOf('child'));
    expect(slugs.indexOf('child')).toBeLessThan(slugs.indexOf('grandchild'));
  });

  test('throws when no organization is defined', () => {
    const app = new App();
    expect(() => synthesize(app)).toThrow(/No Organization/);
  });

  test('throws on duplicate slugs', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'a', { name: 'Dev Team' });
    new Team(org, 'b', { name: 'dev-team' });
    expect(() => synthesize(app)).toThrow(/Duplicate team slug/);
  });
});

describe('synthesize governance', () => {
  test('leaves a surface out of the manifest until it is declared', () => {
    const app = new App();
    new Organization(app, 'acme', { login: 'acme' });

    const state = synthesize(app);

    expect(state.rulesets).toBeUndefined();
    expect(state.codeSecurityConfigurations).toBeUndefined();
    expect(state.customProperties).toBeUndefined();
    expect(state.actions).toBeUndefined();
    expect(state.settings).toBeUndefined();
  });

  test('collects rulesets, the actions policy, configurations, and properties', () => {
    const app = new App();
    const org = new Organization(app, 'acme', {
      login: 'acme',
      settings: { defaultRepositoryPermission: 'read' },
    });
    new Ruleset(org, 'protect-main', {
      enforcement: 'evaluate',
      rules: [{ type: 'deletion' }],
    });
    new ActionsPolicy(org, 'actions', { defaultWorkflowPermissions: 'read' });
    new CodeSecurityConfiguration(org, 'baseline', { description: 'Baseline' });
    new CustomProperty(org, 'tier', {
      valueType: 'single_select',
      allowedValues: ['a', 'b'],
    });

    const state = synthesize(app);

    expect(state.settings).toEqual({ defaultRepositoryPermission: 'read' });
    expect(state.actions).toEqual({ defaultWorkflowPermissions: 'read' });
    // target defaults to branch, name falls back to the construct id
    expect(state.rulesets).toEqual([
      {
        name: 'protect-main',
        target: 'branch',
        enforcement: 'evaluate',
        conditions: undefined,
        rules: [{ type: 'deletion' }],
        bypassActors: undefined,
      },
    ]);
    expect(state.codeSecurityConfigurations?.[0]?.name).toBe('baseline');
    expect(state.customProperties?.[0]?.name).toBe('tier');
  });

  test('rejects a second actions policy', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new ActionsPolicy(org, 'a', {});
    new ActionsPolicy(org, 'b', {});
    expect(() => synthesize(app)).toThrow(/at most one ActionsPolicy/);
  });

  test('rejects a select property with no allowed values', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new CustomProperty(org, 'tier', { valueType: 'single_select' });
    expect(() => synthesize(app)).toThrow(/declares no allowedValues/);
  });

  test('rejects a configuration that both scopes and lists its attachments', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new CodeSecurityConfiguration(org, 'baseline', {
      description: 'Baseline',
      attach: 'all',
      attachRepositories: ['app'],
    });
    expect(() => synthesize(app)).toThrow(/Choose a scope or a repository list/);
  });

  test('rejects duplicate ruleset names', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Ruleset(org, 'a', { name: 'same', rules: [] });
    new Ruleset(org, 'b', { name: 'same', rules: [] });
    expect(() => synthesize(app)).toThrow(/Duplicate ruleset name/);
  });
});
