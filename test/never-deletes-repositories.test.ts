import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../src/reconcile/applier.ts';
import type { Change } from '../src/reconcile/changes.ts';
import { FakeClient } from './fake-client.ts';

/**
 * Removing a repository from a definition must never remove the repository.
 *
 * Creating one is supported, because it is recoverable: a repository made by
 * mistake is deleted by hand in seconds. Deleting is not, and the edit that
 * drops a repository from a definition is textually identical to the edit that
 * drops it from the company. So the asymmetry is deliberate — `createInOrg` and
 * nothing that removes, transfers or archives.
 *
 * These are guards rather than behaviour. They fail if someone adds repository
 * deletion later, which is the point.
 */

function sourceFiles(base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(base)) {
    const full = join(base, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('a repository is never deleted', () => {
  test('the client can create one and cannot remove one', () => {
    const client = readFileSync('src/github/client.ts', 'utf8');

    // Octokit's `repos.*` namespace covers rulesets and branch protection too,
    // so match the calls that act on the repository itself.
    expect(client).not.toContain('repos.delete(');
    // Creating is the one direction offered, and it is recoverable. Through
    // the raw route, because `internal` is missing from the generated types.
    expect(client).toContain('POST /orgs/{org}/repos');
    expect(client).not.toContain('repos.transfer');
    expect(client).not.toContain('repos.createFork');
    expect(client).not.toMatch(/DELETE \/repos\/\{owner\}\/\{repo\}'/);
  });

  test('no change kind names repository deletion', () => {
    const changes = readFileSync('src/reconcile/changes.ts', 'utf8');
    const kinds = [...changes.matchAll(/readonly kind: '([a-z-]+)'/g)].map(
      (m) => m[1] as string,
    );

    // `remove-repo-access` takes a team off a repository. Nothing takes the
    // repository off GitHub.
    expect(kinds).toContain('remove-repo-access');
    expect(kinds).toContain('create-repository');
    expect(kinds).not.toContain('delete-repository');
    expect(kinds).not.toContain('update-repository');
    expect(
      kinds.filter((k) => /^delete-repo$|^delete-repository/.test(k)),
    ).toEqual([]);
  });

  test('dropping every grant leaves the repository alone', async () => {
    const client = new FakeClient({
      teams: [
        {
          id: 1,
          slug: 'cloud',
          name: 'cloud',
          description: null,
          privacy: 'closed',
          parentSlug: null,
        },
      ],
    });

    const changes: Change[] = [
      {
        kind: 'remove-repo-access',
        slug: 'cloud',
        repository: 'netcore',
        from: 'push',
      },
    ];

    await apply(client, 'acme', changes, { teams: [] }, { allowDelete: true });

    // The only call made is the one that unlinks the team.
    expect(client.callsTo('removeRepoPermission')).toEqual([
      { slug: 'cloud', repo: 'netcore' },
    ]);
    expect(client.calls.map((c) => c.method)).not.toContain('deleteRepository');
  });

  test('no source file references a repository-deleting endpoint', () => {
    const offenders = sourceFiles('src').filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /repos\.delete\(|repos\.transfer|DELETE \/repos\/\{owner\}\/\{repo\}'/.test(
        text,
      );
    });
    expect(offenders).toEqual([]);
  });
});
