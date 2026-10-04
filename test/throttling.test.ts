import { afterEach, describe, expect, test } from 'bun:test';
import { OctokitGitHubClient } from '../src/github/client.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * A GitHub that answers every request after `delayMs` and records how many
 * were in flight at once.
 */
function serveSlowly(delayMs: number, body: unknown) {
  const seen = { inFlight: 0, most: 0, requests: 0 };
  globalThis.fetch = (async () => {
    seen.requests += 1;
    seen.inFlight += 1;
    seen.most = Math.max(seen.most, seen.inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    seen.inFlight -= 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return seen;
}

describe('request pacing', () => {
  test('GraphQL queries run fifty at a time, not one a second', async () => {
    const seen = serveSlowly(500, {
      data: {
        organization: {
          team: { members: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [] } },
        },
      },
    });
    const client = new OctokitGitHubClient('token');
    const started = performance.now();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => client.listTeamMembers('acme', `team-${i}`)),
    );
    expect(seen.requests).toBe(60);
    expect(seen.most).toBe(50);
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 20_000);

  test('REST writes still go one at a time, a second apart', async () => {
    const seen = serveSlowly(10, {});
    const client = new OctokitGitHubClient('token');
    const started = performance.now();
    await Promise.all(
      ['A', 'B', 'C'].map((name) => client.deleteOrgSecret('acme', name)),
    );
    expect(seen.most).toBe(1);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1_900);
  });
});
