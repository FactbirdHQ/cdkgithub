import { describe, expect, test } from 'bun:test';
import { App, maintain, Organization, push, Team } from '../../src/index.ts';
import { synthesize } from '../../src/synth/synthesizer.ts';

/**
 * Checked on its own, by `test/vocabulary/tsconfig.json`.
 *
 * Augmenting `Vocabulary` is global to a compilation unit, so declaring one
 * here would narrow every other test in the suite to these two repositories.
 * That is the mechanism working, not a bug, and the reason it is kept apart.
 *
 * A definition names what it has, once. Everything below is checked against it
 * with nothing said at the point of use.
 */
const USERS = ['ana', 'bo'] as const;
const REPOSITORIES = ['netcore', 'fctl'] as const;

declare module '../../src/index.ts' {
  interface Vocabulary {
    member: (typeof USERS)[number];
    repository: (typeof REPOSITORIES)[number];
  }
}

describe('a declared vocabulary', () => {
  test('a roster and a grant of declared names synthesize as before', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new Team(org, 'cloud', {
      members: ['ana'],
      repositories: [maintain('netcore'), push('fctl')],
    });

    expect(synthesize(app.node.root).teams[0]).toMatchObject({
      members: ['ana'],
      repositories: { netcore: 'maintain', fctl: 'push' },
    });
  });

  test('a person who is not declared does not compile', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    // @ts-expect-error 'anna' is not one of USERS
    new Team(org, 'cloud', { members: ['anna'] });
    expect(org).toBeDefined();
  });

  test('addTeam and addSubTeam check the roster the same way', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const cloud = org.addTeam('cloud', { members: ['ana'] });
    // @ts-expect-error 'anna' is not one of USERS
    org.addTeam('ops', { members: ['anna'] });
    // @ts-expect-error 'anna' is not one of USERS
    cloud.addSubTeam('devops', { members: ['anna'] });
    expect(org).toBeDefined();
  });

  test('a repository that is not declared does not compile', () => {
    // @ts-expect-error 'nset' is not one of REPOSITORIES
    const grant = push('nset');
    expect(grant).toBeDefined();
  });
});
