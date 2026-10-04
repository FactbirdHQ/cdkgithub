import { describe, expect, test } from 'bun:test';
import { App, Collaborator, Organization, Repository } from '../src/index.ts';
import { accessByPerson } from '../src/reconcile/access-by-person.ts';
import { apply } from '../src/reconcile/applier.ts';
import { readLiveState } from '../src/reconcile/live.ts';
import { plan } from '../src/reconcile/planner.ts';
import { desiredTree, readLiveTree } from '../src/reconcile/tree.ts';
import type { DesiredState } from '../src/synth/manifest.ts';
import { synthesize } from '../src/synth/synthesizer.ts';
import { FakeClient } from './fake-client.ts';

function desired(overrides: Partial<DesiredState> = {}): DesiredState {
  return { owner: 'acme', ownerType: 'organization', teams: [], ...overrides };
}

describe('synthesis', () => {
  test('the prop, the method and the construct declare the same grant', () => {
    const asProp = new App();
    new Repository(new Organization(asProp, 'acme', { login: 'acme' }), 'atat', {
      collaborator: { dawn: 'triage' },
    });
    const asMethod = new App();
    new Repository(new Organization(asMethod, 'acme', { login: 'acme' }), 'atat').addCollaborator(
      'dawn',
      'triage',
    );
    const asConstruct = new App();
    new Collaborator(new Repository(new Organization(asConstruct, 'acme', { login: 'acme' }), 'atat'), 'dawn', {
      permission: 'triage',
    });

    const expected = [{ repository: 'atat', login: 'dawn', permission: 'triage' }];
    expect(synthesize(asConstruct).collaborators).toEqual(expected);
    expect(synthesize(asMethod).collaborators).toEqual(expected);
    expect(synthesize(asProp).collaborators).toEqual(expected);
    // Collaborators are the repository's contents, not what it is created with.
    expect(synthesize(asProp).repositories).toEqual([{ name: 'atat' }]);
  });

  test('a login is one grant per repository, whatever its case', () => {
    const app = new App();
    const atat = new Repository(new Organization(app, 'acme', { login: 'acme' }), 'atat');
    atat.addCollaborator('dawn', 'triage');
    new Collaborator(atat, 'second', { login: 'DAWN', permission: 'push' });
    expect(() => synthesize(app)).toThrow('Duplicate collaborator');
  });
});

describe('plan and apply', () => {
  test('are unmanaged until one is declared', async () => {
    const state = desired({ repositories: [{ name: 'atat' }] });
    const client = new FakeClient({ collaborators: { atat: [{ login: 'dawn', permission: 'push' }] } });
    const liveState = await readLiveState(client, state);
    expect(liveState.repositoryCollaborators).toBeUndefined();
    expect(plan(state, liveState).filter((c) => c.kind.includes('collaborator'))).toEqual([]);
  });

  test('grant, change, and prune members and invitations on every declared repository', async () => {
    const state = desired({
      repositories: [{ name: 'atat' }, { name: 'rustot' }],
      collaborators: [
        { repository: 'atat', login: 'DAWN', permission: 'triage' },
        { repository: 'atat', login: 'casey', permission: 'push' },
        { repository: 'atat', login: 'kept', permission: 'push' },
      ],
    });
    const client = new FakeClient({
      collaborators: {
        atat: [
          { login: 'dawn', permission: 'push' },
          { login: 'casey', permission: 'pull', invitationId: 41 },
          { login: 'kept', permission: 'push' },
          { login: 'stale', permission: 'admin' },
        ],
        // Declares nothing, and is owned all the same.
        rustot: [{ login: 'ada', permission: 'pull', invitationId: 42 }],
      },
    });
    const changes = plan(state, await readLiveState(client, state)).filter((c) =>
      c.kind.includes('collaborator'),
    );

    expect(changes.map((c) => c.kind)).toEqual([
      'set-collaborator',
      'set-collaborator',
      'remove-collaborator',
      'remove-collaborator',
    ]);

    await apply(client, 'acme', changes, await readLiveState(client, state), {
      allowDelete: new Set(['remove-collaborator' as const]),
    });
    expect(client.callsTo('putRepositoryCollaborator')).toEqual([
      { repo: 'atat', login: 'DAWN', permission: 'triage' },
    ]);
    expect(client.callsTo('updateRepositoryInvitation')).toEqual([
      { repo: 'atat', invitationId: 41, permission: 'push' },
    ]);
    expect(client.callsTo('deleteRepositoryCollaborator')).toEqual([{ repo: 'atat', login: 'stale' }]);
    expect(client.callsTo('deleteRepositoryInvitation')).toEqual([{ repo: 'rustot', invitationId: 42 }]);
  });
});

describe('the access review', () => {
  test('shows a direct grant, and leaves a pending invitation out of the live side', async () => {
    const state = desired({
      repositories: [{ name: 'atat' }],
      collaborators: [{ repository: 'atat', login: 'dawn', permission: 'triage' }],
    });
    const wanted = accessByPerson(desiredTree(state)).get('dawn');
    expect(wanted?.repositories.get('atat')).toEqual({
      repository: 'atat',
      permission: 'triage',
      through: ['direct collaborator'],
    });

    const client = new FakeClient({
      collaborators: {
        atat: [
          { login: 'dawn', permission: 'push' },
          { login: 'casey', permission: 'pull', invitationId: 41 },
        ],
      },
    });
    const people = accessByPerson(await readLiveTree(client, 'acme', 'organization', ['atat']));
    expect(people.get('dawn')?.repositories.get('atat')?.permission).toBe('push');
    expect(people.has('casey')).toBe(false);
  });
});

describe('reading them back', () => {
  test('lists every repository in one call', async () => {
    const state = desired({
      repositories: [{ name: 'atat' }],
      collaborators: [{ repository: 'rustot', login: 'dawn', permission: 'triage' }],
    });
    const client = new FakeClient({});
    await readLiveState(client, state);
    expect(client.callsTo('listCollaboratorsOfRepositories')).toEqual([['atat', 'rustot']]);
  });

  test('a missing repository is empty when the run creates it, and a failure otherwise', async () => {
    const client = new FakeClient({ missingRepositories: ['atat', 'typo'] });
    const creating = desired({
      repositories: [{ name: 'atat' }],
      collaborators: [{ repository: 'atat', login: 'dawn', permission: 'triage' }],
    });
    expect((await readLiveState(client, creating)).repositoryCollaborators).toEqual([]);

    const typo = desired({
      collaborators: [{ repository: 'typo', login: 'dawn', permission: 'triage' }],
    });
    await expect(readLiveState(client, typo)).rejects.toThrow('Repository "typo" was not found');
    await expect(readLiveTree(client, 'acme', 'organization', ['typo'])).rejects.toThrow(
      'Repository "typo" was not found',
    );
  });
});
