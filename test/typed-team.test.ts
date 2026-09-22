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
