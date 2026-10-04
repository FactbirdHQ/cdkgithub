import { describe, expect, test } from 'bun:test';
import { appliedLine, massDeleteGuard, parseFlags } from '../src/cli.ts';
import type { Change } from '../src/reconcile/changes.ts';
import { validateManifest } from '../src/synth/validate.ts';

describe('flag parsing', () => {
  test('a misspelled flag is an error, not a silently different apply', () => {
    expect(() => parseFlags(['--alow-delete'], 'apply')).toThrow(
      'Unknown option: --alow-delete',
    );
    expect(() => parseFlags(['--ye'], 'apply')).toThrow('Unknown option');
  });

  test('a stray positional is an error outside synth', () => {
    expect(() => parseFlags(['manifest.json'], 'apply')).toThrow(
      'Unexpected argument',
    );
    expect(() => parseFlags(['examples/acme.ts'], 'synth')).not.toThrow();
  });

  test('--manifest requires a path', () => {
    expect(() => parseFlags(['--manifest'], 'plan')).toThrow(
      '--manifest needs a path',
    );
    expect(() => parseFlags(['--manifest', '--yes'], 'plan')).toThrow(
      '--manifest needs a path',
    );
  });

  test('--repositories: bare walks everything, names narrow it', () => {
    expect(parseFlags([], 'import').repositories).toBe(false);
    expect(parseFlags(['--repositories'], 'import').repositories).toBe(true);
    expect(
      parseFlags(['--repositories=netcore,flow-portal'], 'import').repositories,
    ).toEqual(['netcore', 'flow-portal']);
    expect(() => parseFlags(['--repositories='], 'import')).toThrow(
      'at least one repository name',
    );
  });

  test('import takes one org and an optional --output path', () => {
    expect(parseFlags(['acme'], 'import').positional).toBe('acme');
    expect(
      parseFlags(['--output', 'examples/acme.ts', 'acme'], 'import'),
    ).toMatchObject({ positional: 'acme', output: 'examples/acme.ts' });
    expect(() => parseFlags(['acme', 'other'], 'import')).toThrow(
      'Unexpected argument',
    );
    expect(() => parseFlags(['--output'], 'import')).toThrow(
      '--output needs a path',
    );
  });

  test('--allow-delete: bare permits everything, scopes narrow it', () => {
    expect(parseFlags([], 'apply').allowDelete).toBe(false);
    expect(parseFlags(['--allow-delete'], 'apply').allowDelete).toBe(true);
    expect(
      parseFlags(['--allow-delete=teams,grants'], 'apply').allowDelete,
    ).toEqual(['teams', 'grants']);
    expect(() => parseFlags(['--allow-delete=tems'], 'apply')).toThrow(
      'Unknown --allow-delete scope "tems"',
    );
    expect(() => parseFlags(['--allow-delete='], 'apply')).toThrow(
      'at least one scope',
    );
  });

  test('--require-approval takes its three levels and nothing else', () => {
    expect(parseFlags([], 'apply').requireApproval).toBe('destructive');
    expect(
      parseFlags(['--require-approval', 'never'], 'apply').requireApproval,
    ).toBe('never');
    expect(
      parseFlags(['--require-approval', 'any-change'], 'apply')
        .requireApproval,
    ).toBe('any-change');
    expect(() => parseFlags(['--require-approval', 'always'], 'apply')).toThrow(
      '--require-approval takes',
    );
  });
});

describe('mass-delete guard', () => {
  const deletes = (count: number): Change[] =>
    Array.from({ length: count }, (_, i) => ({
      kind: 'delete' as const,
      live: {
        id: i,
        slug: `team-${i}`,
        name: `team-${i}`,
        description: null,
        privacy: 'closed' as const,
        parentSlug: null,
      },
    }));

  test('lets small prunes through', () => {
    expect(massDeleteGuard(deletes(2), 4, false)).toBeUndefined();
    expect(massDeleteGuard(deletes(3), 20, false)).toBeUndefined();
  });

  test('refuses deleting half the org without --force', () => {
    const message = massDeleteGuard(deletes(5), 8, false);
    expect(message).toContain('Refusing to delete 5 of 8 teams');
    expect(message).toContain('--force');
  });

  test('--force overrides, deliberately', () => {
    expect(massDeleteGuard(deletes(8), 8, true)).toBeUndefined();
  });
});

describe('manifest validation', () => {
  const good = {
    owner: 'acme',
    ownerType: 'organization',
    teams: [{ slug: 'web', name: 'Web', privacy: 'closed' }],
  };

  test('accepts a minimal manifest', () => {
    expect(validateManifest(good, 'm.json').owner).toBe('acme');
  });

  test('rejects what a truncated or foreign file looks like', () => {
    expect(() => validateManifest(null, 'm.json')).toThrow('JSON object');
    expect(() => validateManifest([], 'm.json')).toThrow('JSON object');
    expect(() => validateManifest({}, 'm.json')).toThrow('"owner"');
    expect(() =>
      validateManifest({ ...good, ownerType: 'org' }, 'm.json'),
    ).toThrow('"ownerType"');
    expect(() =>
      validateManifest({ ...good, teams: undefined }, 'm.json'),
    ).toThrow('"teams" must be an array');
  });

  test('rejects malformed teams before they widen the plan', () => {
    expect(() =>
      validateManifest({ ...good, teams: [{ name: 'Web' }] }, 'm.json'),
    ).toThrow('needs a non-empty "slug"');
    expect(() =>
      validateManifest(
        { ...good, teams: [{ slug: 'web', name: 'Web', privacy: 'open' }] },
        'm.json',
      ),
    ).toThrow('"privacy"');
    expect(() =>
      validateManifest(
        {
          ...good,
          teams: [
            { slug: 'web', name: 'Web', privacy: 'closed', members: 'octocat' },
          ],
        },
        'm.json',
      ),
    ).toThrow('"members"');
    expect(() =>
      validateManifest(
        {
          ...good,
          teams: [
            {
              slug: 'web',
              name: 'Web',
              privacy: 'closed',
              repositories: { app: 7 },
            },
          ],
        },
        'm.json',
      ),
    ).toThrow('"repositories"');
  });

  test('rejects a governance collection of the wrong shape', () => {
    expect(() =>
      validateManifest({ ...good, rulesets: {} }, 'm.json'),
    ).toThrow('"rulesets" must be an array');
  });
});

describe('the line an apply ends on', () => {
  const none = { created: 0, updated: 0, linked: 0, deleted: 0, governance: 0, skipped: [] };

  test('names only the kinds of change it made', () => {
    expect(appliedLine({ ...none, created: 1, updated: 1, deleted: 1 })).toBe(
      'Applied: 1 created, 1 updated, 1 deleted.',
    );
    expect(appliedLine({ ...none, governance: 1 })).toBe('Applied: 1 governance change.');
    expect(appliedLine({ ...none, governance: 2 })).toBe('Applied: 2 governance changes.');
  });

  test('says so when everything was skipped', () => {
    expect(appliedLine({ ...none, skipped: ['delete team old (use --allow-delete)'] })).toBe(
      'Applied nothing.',
    );
  });
});

describe('--verbose', () => {
  test('is off unless asked for, and -v asks for it', () => {
    expect(parseFlags([], 'plan').verbose).toBe(false);
    expect(parseFlags(['--verbose'], 'plan').verbose).toBe(true);
    expect(parseFlags(['-v'], 'plan').verbose).toBe(true);
  });
});
