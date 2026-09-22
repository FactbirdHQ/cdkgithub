import { describe, expect, test } from 'bun:test';
import type { LiveState } from '../src/reconcile/live.ts';
import { planRepositories } from '../src/reconcile/plan-repositories.ts';

const live: LiveState = {
  teams: [],
  repositories: [
    { id: 1, name: 'nest' },
    { id: 2, name: 'Flight-Deck' },
  ],
};

describe('planning repositories', () => {
  test('declaring nothing leaves the surface alone', () => {
    expect(planRepositories(undefined, live)).toEqual([]);
  });

  test('one GitHub already has is adopted, not changed', () => {
    expect(
      planRepositories([{ name: 'nest', description: 'different' }], live),
    ).toEqual([]);
  });

  test('matching ignores case, because GitHub does', () => {
    // A create for `flight-deck` beside a live `Flight-Deck` is a 422.
    expect(planRepositories([{ name: 'flight-deck' }], live)).toEqual([]);
  });

  test('one GitHub does not have is created', () => {
    expect(planRepositories([{ name: 'brand-new' }], live)).toEqual([
      { kind: 'create-repository', repository: { name: 'brand-new' } },
    ]);
  });

  test('a declaration removed proposes nothing at all', () => {
    // `nest` is live and undeclared: adoption has no opposite.
    expect(planRepositories([{ name: 'brand-new' }], live)).not.toContainEqual(
      expect.objectContaining({ kind: 'delete-repository' }),
    );
  });
});
