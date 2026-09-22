import { describe, expect, test } from 'bun:test';
import {
  orphanRepositories,
  renderOrphans,
} from '../src/reconcile/orphan-repositories.ts';

const live = [
  { id: 1, name: 'netcore' },
  { id: 2, name: 'forgotten' },
  { id: 3, name: 'Also-Forgotten' },
];

const plain = { muted: (s: string) => s };

describe('orphaned repositories', () => {
  test('one nothing mentions and no team reaches is undeclared', () => {
    expect(orphanRepositories(live, ['netcore'], ['netcore'])).toEqual([
      { name: 'Also-Forgotten', reason: 'undeclared' },
      { name: 'forgotten', reason: 'undeclared' },
    ]);
  });

  test('a repository a team reaches is not orphaned, declared or not', () => {
    expect(
      orphanRepositories(live, ['netcore'], ['netcore', 'forgotten']).map(
        (o) => o.name,
      ),
    ).toEqual(['Also-Forgotten']);
  });

  test('a declared repository no team reaches is unreachable, not undeclared', () => {
    // Declaring the estate makes a repository visible. It does not give anyone
    // access to it, and that is the half worth naming separately.
    expect(orphanRepositories(live, ['netcore', 'forgotten'], ['netcore'])).toEqual([
      { name: 'Also-Forgotten', reason: 'undeclared' },
      { name: 'forgotten', reason: 'unreachable' },
    ]);
  });

  test('matching ignores case, because GitHub does', () => {
    expect(
      orphanRepositories(live, undefined, [
        'netcore',
        'forgotten',
        'also-forgotten',
      ]),
    ).toEqual([]);
  });

  test('a definition declaring no repositories reports by grants alone', () => {
    expect(
      orphanRepositories(live, undefined, ['netcore']).map((o) => o.reason),
    ).toEqual(['undeclared', 'undeclared']);
  });

  test('nothing is reported when the live list was never read', () => {
    expect(orphanRepositories(undefined, ['netcore'], [])).toEqual([]);
  });

  test('the report separates the two and says what to do about each', () => {
    const text = renderOrphans(
      orphanRepositories(live, ['forgotten'], ['netcore']),
      plain,
    );
    expect(text).toContain(
      '1 repository the definition does not mention at all',
    );
    expect(text).toContain('Declare it or archive it');
    expect(text).toContain('1 declared repository that no team reaches');
    expect(text).toContain('open to nobody except the organization owners');
  });

  test('nothing is printed when there are none', () => {
    expect(renderOrphans([], plain)).toBe('');
  });
});
