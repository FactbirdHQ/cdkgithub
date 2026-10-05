import { describe, expect, test } from 'bun:test';

import { App, Organization, Team, teamOf } from '../src/index.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

const USERS = ['ana', 'bo'] as const;
const TypedTeam = teamOf<(typeof USERS)[number]>();

describe('a team bound to a list of people', () => {
  test('it is the same construct, so synthesis is unchanged', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new TypedTeam(org, 'cloud', { members: ['ana', 'bo'] });

    expect(synthesize(app.node.root).teams[0]).toMatchObject({
      slug: 'cloud',
      members: ['ana', 'bo'],
    });
  });

  test('instanceof still finds it, which is how synth collects teams', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    const team = new TypedTeam(org, 'cloud', {});
    expect(team).toBeInstanceOf(Team);
  });

  test('a name outside the list does not compile', () => {
    // @ts-expect-error 'anna' is not one of USERS
    const props = { members: ['anna'] } as const satisfies {
      members: readonly (typeof USERS)[number][];
    };
    expect(props).toBeDefined();
  });
});

describe('addTeam and addSubTeam', () => {
  test('the methods and nested constructs build the same team tree', () => {
    const asMethods = new App();
    new Organization(asMethods, 'acme', { login: 'acme' })
      .addTeam('Engineering', { maintainers: ['casey'] })
      .addSubTeam('Cloud', { members: ['ada'] })
      .addSubTeam('DevOps');

    const asConstructs = new App();
    const org = new Organization(asConstructs, 'acme', { login: 'acme' });
    const engineering = new Team(org, 'Engineering', { maintainers: ['casey'] });
    new Team(new Team(engineering, 'Cloud', { members: ['ada'] }), 'DevOps');

    const teams = synthesize(asConstructs).teams;
    expect(teams.map((t) => [t.slug, t.parentSlug])).toEqual([
      ['engineering', undefined],
      ['cloud', 'engineering'],
      ['devops', 'cloud'],
    ]);
    expect(synthesize(asMethods).teams).toEqual(teams);
  });
});
