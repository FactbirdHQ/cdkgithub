#!/usr/bin/env bun
/**
 * The CLI the README recording runs: the real commands against an in-memory
 * organization, so the recording needs no token and writes nothing to GitHub.
 * Every call waits a moment and answers with rate-limit headers, so the read
 * and apply screens have something to show.
 *
 *   vhs docs/demo/cdkgithub.tape
 */
import { main } from '../../src/cli.ts';
import type { GitHubClient } from '../../src/github/client.ts';
import { RequestMeter } from '../../src/github/meter.ts';
import { FakeClient } from '../../test/fake-client.ts';

const team = (id: number, slug: string, parentSlug: string | null = null) => ({
  id,
  slug,
  name: slug,
  description: null,
  privacy: 'closed' as const,
  parentSlug,
});

const github = new FakeClient({
  teams: [team(1, 'engineering'), team(2, 'cloud'), team(3, 'legacy-tools')],
  teamRepositories: {
    cloud: [{ name: 'netcore', roleName: 'push' }],
    'legacy-tools': [{ name: 'netcore', roleName: 'pull' }],
  },
});

/** The REST route each call stands for, as the read summary names it. */
const ROUTES: Record<string, string> = {
  listTeams: 'GET /orgs/{org}/teams',
  listTeamRepositories: 'GET /orgs/{org}/teams/{team_slug}/repos',
  listOrgVariables: 'GET /orgs/{org}/actions/variables',
  listOrgSecrets: 'GET /orgs/{org}/actions/secrets',
  createTeam: 'POST /orgs/{org}/teams',
  setRepoPermission: 'PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}',
  deleteTeam: 'DELETE /orgs/{org}/teams/{team_slug}',
};

const meter = new RequestMeter();
const resetsAt = Math.floor(Date.now() / 1000) + 40 * 60;
let remaining = 4_812;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `github`, answering each call after a delay with the headers GitHub sends. */
const client = new Proxy(github, {
  get(target, property, receiver) {
    if (property === 'meter') {
      return meter;
    }
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') {
      return value;
    }
    const name = String(property);
    const writes = !/^(list|get|find|read)/.test(name);
    return async (...args: unknown[]) => {
      await sleep(writes ? 550 + Math.random() * 250 : 900 + Math.random() * 500);
      remaining -= 1;
      meter.record(ROUTES[name] ?? `${writes ? 'POST' : 'GET'} ${name}`, {
        'x-ratelimit-remaining': String(remaining),
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': String(resetsAt),
      });
      return value.apply(target, args);
    };
  },
}) as unknown as GitHubClient & { meter: RequestMeter };

process.exit(await main(process.argv.slice(2), () => ({ client })));
