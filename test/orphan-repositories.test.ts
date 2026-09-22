import { describe, expect, test } from 'bun:test';
import {
  orphanRepositories,
  renderOrphans,
} from '../src/reconcile/orphan-repositories.ts';

const live = [
  { id: 1, name: 'nest' },
  { id: 2, name: 'forgotten' },
  { id: 3, name: 'Also-Forgotten' },
];

const plain = { muted: (s: string) => s };

describe('orphaned repositories', () => {
  test('one no team reaches and nothing declares is orphaned', () => {
    expect(orphanRepositories(live, ['nest'], ['nest'])).toEqual([
      { name: 'Also-Forgotten', unreachable: true },
      { name: 'forgotten', unreachable: true },
    ]);
  });

  test('a repository a team reaches is not orphaned, declared or not', () => {
    expect(
      orphanRepositories(live, ['nest'], ['nest', 'forgotten']).map(
        (o) => o.name,
      ),
    ).toEqual(['Also-Forgotten']);
  });

  test('matching ignores case, because GitHub does', () => {
    expect(
      orphanRepositories(live, undefined, [
        'nest',
        'forgotten',
        'also-forgotten',
      ]),
    ).toEqual([]);
  });

  test('a definition declaring no repositories still reports by grants', () => {
    expect(
      orphanRepositories(live, undefined, ['nest']).map((o) => o.name),
    ).toEqual(['Also-Forgotten', 'forgotten']);
  });

  test('nothing is reported when the live list was never read', () => {
    expect(orphanRepositories(undefined, ['nest'], [])).toEqual([]);
  });

  test('the report names them and says what to do', () => {
    const text = renderOrphans(orphanRepositories(live, [], ['nest']), plain);
    expect(text).toContain('2 repositories in the organization');
    expect(text).toContain('Declare it or archive it');
    expect(text).toContain('forgotten');
  });

  test('nothing is printed when there are none', () => {
    expect(renderOrphans([], plain)).toBe('');
  });
});
