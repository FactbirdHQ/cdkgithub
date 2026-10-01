import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { OctokitGitHubClient } from '../src/github/client.ts';
import { EtagCache } from '../src/github/etag-cache.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const rate = { 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1900000000' };

/** A GitHub that serves `pages` of teams under fixed ETags and honours If-None-Match. */
function serveTeams(pages: Array<Array<{ slug: string }>>) {
  const conditional: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get('page') ?? '1');
    const etag = `"teams-${page}"`;
    const asked = new Headers(init?.headers).get('if-none-match');
    conditional.push(asked);
    const link =
      page < pages.length
        ? `<https://api.github.com/orgs/acme/teams?per_page=100&page=${page + 1}>; rel="next"`
        : undefined;
    if (asked === etag) return new Response(null, { status: 304, headers: { etag, ...rate } });
    return new Response(
      JSON.stringify(
        pages[page - 1]!.map((t, i) => ({
          id: page * 100 + i,
          slug: t.slug,
          name: t.slug,
          description: null,
          privacy: 'closed',
          parent: null,
        })),
      ),
      { status: 200, headers: { 'content-type': 'application/json', etag, ...(link ? { link } : {}), ...rate } },
    );
  }) as typeof fetch;
  return conditional;
}

describe('the ETag cache', () => {
  test('answers an unchanged listing from the cache, pages included', async () => {
    const conditional = serveTeams([[{ slug: 'cloud' }], [{ slug: 'devops' }]]);
    const cache = new EtagCache();

    const first = new OctokitGitHubClient('token', undefined, undefined, cache);
    const cold = await first.listTeams('acme');
    expect(conditional).toEqual([null, null]);
    expect(first.meter.snapshot().requests).toEqual({ core: 2, graphql: 0, cached: 0 });

    const second = new OctokitGitHubClient('token', undefined, undefined, cache);
    const warm = await second.listTeams('acme');
    expect(warm).toEqual(cold);
    expect(warm.map((t) => t.slug)).toEqual(['cloud', 'devops']);
    expect(conditional.slice(2)).toEqual(['"teams-1"', '"teams-2"']);
    expect(second.meter.snapshot().requests).toEqual({ core: 0, graphql: 0, cached: 2 });
  });

  test('a write empties the cache and a GraphQL query does not', async () => {
    const conditional = serveTeams([[{ slug: 'cloud' }]]);
    const realServe = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/graphql') {
        return new Response(JSON.stringify({ data: { viewer: { login: 'x' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json', ...rate },
        });
      }
      if (init?.method === 'PATCH') return new Response(null, { status: 422, headers: rate });
      return realServe(input, init);
    }) as typeof fetch;
    const cache = new EtagCache();
    const client = new OctokitGitHubClient('token', undefined, undefined, cache);
    await client.listTeams('acme');
    const octokit = (client as unknown as { octokit: Octokit }).octokit;

    await octokit.graphql('query { viewer { login } }');
    expect(cache.get('https://api.github.com/orgs/acme/teams?per_page=100')).toBeDefined();

    // Rejected, yet a failed write may still have landed.
    await expect(octokit.request('PATCH /orgs/{org}', { org: 'acme' })).rejects.toThrow();
    expect(cache.get('https://api.github.com/orgs/acme/teams?per_page=100')).toBeUndefined();

    await client.listTeams('acme');
    expect(conditional).toEqual([null, null]);
  });

  test('keeps nothing between runs until saved, then everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkgithub-cache-'));
    try {
      const cache = EtagCache.open(dir, 'token-a');
      cache.set('https://api.github.com/orgs/acme/teams', { etag: '"a"', data: [1] });
      expect(EtagCache.open(dir, 'token-a').get('https://api.github.com/orgs/acme/teams')).toBeUndefined();

      cache.save();
      expect(EtagCache.open(dir, 'token-a').get('https://api.github.com/orgs/acme/teams')).toEqual({
        etag: '"a"',
        data: [1],
      });
      // Another token gets its own file and never sees this one's responses.
      expect(EtagCache.open(dir, 'token-b').get('https://api.github.com/orgs/acme/teams')).toBeUndefined();
      expect(readdirSync(join(dir, 'cache'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unreadable cache file starts empty rather than failing the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkgithub-cache-'));
    try {
      const cache = EtagCache.open(dir, 'token');
      cache.set('u', { etag: '"a"', data: 1 });
      cache.save();
      const [file] = readdirSync(join(dir, 'cache'));
      writeFileSync(join(dir, 'cache', file!), '{ truncated');
      expect(EtagCache.open(dir, 'token').get('u')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a wrapped list answered from the cache', () => {
  test('unwraps the same on a 304 as on the first read', async () => {
    const etag = '"installations"';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { etag, ...rate } });
      }
      return new Response(
        JSON.stringify({
          total_count: 1,
          installations: [
            { id: 7, app_id: 150926, app_slug: 'ci-token-generator', repository_selection: 'all' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json', etag, ...rate } },
      );
    }) as typeof fetch;

    const cache = new EtagCache();
    const cold = await new OctokitGitHubClient('token', undefined, undefined, cache).listAppInstallations('acme');
    const warmClient = new OctokitGitHubClient('token', undefined, undefined, cache);
    const warm = await warmClient.listAppInstallations('acme');

    expect(cold).toEqual([
      { id: 7, appId: 150926, slug: 'ci-token-generator', repositorySelection: 'all' },
    ]);
    expect(warm).toEqual(cold);
    expect(warmClient.meter.snapshot().requests.cached).toBe(1);
  });

  test('a cache file written before the format version is discarded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkgithub-cache-'));
    try {
      const cache = EtagCache.open(dir, 'token');
      cache.set('u', { etag: '"a"', data: 1 });
      cache.save();
      const [file] = readdirSync(join(dir, 'cache'));
      // The shape the first release wrote: entries at the top level, unversioned.
      writeFileSync(join(dir, 'cache', file!), JSON.stringify({ u: { etag: '"a"', data: { installations: [] } } }));
      expect(EtagCache.open(dir, 'token').get('u')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
