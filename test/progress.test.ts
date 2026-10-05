import { describe, expect, test } from 'bun:test';

import { RequestMeter } from '../src/github/meter.ts';
import { budgetNote, clock, fitToWidth, progressLine, reportProgress, since } from '../src/progress.ts';

const resetAt = 1_900_000_000;
const headers = (remaining: number, resource = 'core', reset = resetAt) => ({
  'x-ratelimit-remaining': String(remaining),
  'x-ratelimit-limit': '5000',
  'x-ratelimit-reset': String(reset),
  'x-ratelimit-resource': resource,
});

describe('RequestMeter', () => {
  test('counts REST and GraphQL apart and keeps the budget left', () => {
    const meter = new RequestMeter();
    meter.record('GET /orgs/{org}/teams', headers(4999));
    meter.record('GET /repos/{owner}/{repo}/environments', headers(4998));
    meter.record('GET /repos/{owner}/{repo}/environments', headers(4997));
    meter.record('POST /graphql', headers(4900, 'graphql'));

    const snapshot = meter.snapshot();
    expect(snapshot.requests).toEqual({ core: 3, graphql: 1, cached: 0 });
    expect(snapshot.budgets.core).toEqual({
      remaining: 4997,
      limit: 5000,
      resetsAt: new Date(resetAt * 1000),
    });
    expect(meter.busiest(1)).toEqual([{ route: 'GET /repos/{owner}/{repo}/environments', requests: 2 }]);
  });

  test('keeps the lowest count when responses arrive out of order', () => {
    const meter = new RequestMeter();
    meter.record('GET /orgs/{org}/teams', headers(4356));
    meter.record('GET /orgs/{org}/teams', headers(4400));
    expect(meter.snapshot().budgets.core?.remaining).toBe(4356);
  });

  test('reports the budget that runs out first when routes draw on two', () => {
    const meter = new RequestMeter();
    const later = resetAt + 2231;
    meter.record('GET /orgs/{org}/rulesets', headers(1751));
    meter.record('GET /orgs/{org}/teams', headers(3024, 'core', later));
    meter.record('GET /orgs/{org}/rulesets', headers(1750));
    meter.record('GET /orgs/{org}/teams', headers(3023, 'core', later));
    const nowMs = (resetAt - 60) * 1000;
    expect(meter.snapshot(nowMs).budgets.core).toEqual({
      remaining: 1750,
      limit: 5000,
      resetsAt: new Date(resetAt * 1000),
    });
    // Once the first has refilled, the other is the one left to report.
    expect(meter.snapshot((resetAt + 1) * 1000).budgets.core?.remaining).toBe(3023);
  });

  test('reports requests waiting out one limit together as one wait', () => {
    const meter = new RequestMeter();
    const waits: unknown[] = [];
    meter.onWait = (wait) => waits.push(wait);
    meter.wait(1242, false);
    meter.wait(1243, false);
    meter.wait(1242, false);
    expect(waits).toHaveLength(1);
    meter.wait(3600, true);
    expect(waits).toHaveLength(2);
    expect(meter.snapshot().waiting?.secondary).toBe(true);

    meter.record('GET /orgs/{org}/teams', headers(4999));
    expect(meter.snapshot().waiting).toBeUndefined();
  });
});

describe('progress lines', () => {
  test('name the wait and the time it ends', () => {
    const meter = new RequestMeter();
    meter.record('GET /orgs/{org}/teams', headers(0));
    meter.wait(1242, false);
    const line = progressLine('Reading live state', meter.snapshot(), 75_000, Date.now());
    expect(line).toMatch(
      /^Reading live state: 1 REST request, 0 GraphQL queries, 1m15s · waiting out GitHub's rate limit until \d\d:\d\d$/,
    );
  });

  test('show the budget left, or that it is spent', () => {
    const meter = new RequestMeter();
    meter.record('GET /orgs/{org}/teams', headers(4188));
    expect(progressLine('Reading', meter.snapshot(), 2_000, 0)).toBe(
      'Reading: 1 REST request, 0 GraphQL queries, 2s · 4,188 API requests left',
    );
    meter.record('GET /orgs/{org}/teams', headers(0));
    expect(progressLine('Reading', meter.snapshot(), 2_000, 0)).toMatch(/· API budget spent until \d\d:\d\d$/);
  });

  test('a log gets the summary: the time taken and the budget left', async () => {
    const meter = new RequestMeter();
    const written: string[] = [];
    const result = await reportProgress(
      'Reading live state',
      meter,
      async () => {
        meter.record('GET /repos/{owner}/{repo}/environments', headers(10));
        return 42;
      },
      { write: (text: string) => written.push(text), isTTY: false },
    );
    expect(result).toBe(42);
    expect(written.at(-1)).toBe('Reading live state took 0s. API budget: 10 of 5,000 left.\n');
  });

  test('a verbose summary adds the requests and the busiest routes', async () => {
    const meter = new RequestMeter();
    const written: string[] = [];
    await reportProgress(
      'Reading live state',
      meter,
      async () => {
        meter.record('GET /repos/{owner}/{repo}/environments', headers(10));
      },
      { write: (text: string) => written.push(text), isTTY: false },
      Date.now,
      true,
    );
    expect(written.at(-1)).toMatch(
      /^Reading live state took 0s and 1 REST request, 0 GraphQL queries\. Most requested: GET \/repos\/\{owner\}\/\{repo\}\/environments \(1\)\. API budget: 10 of 5,000 left, refilled at \d\d:\d\d\.\n$/,
    );
  });

  test('a terminal gets its line cleared when the read fails', async () => {
    const written: string[] = [];
    await expect(
      reportProgress(
        'Reading',
        new RequestMeter(),
        async () => {
          throw new Error('boom');
        },
        { write: (text: string) => written.push(text), isTTY: true },
      ),
    ).rejects.toThrow('boom');
    expect(written.at(-1)).toBe('\r\x1b[2K');
  });
});

describe('budgetNote', () => {
  test('warns only when the changes outnumber the requests left', () => {
    const meter = new RequestMeter();
    meter.record('GET /orgs/{org}/teams', headers(12));
    expect(budgetNote(12, meter.snapshot())).toBeUndefined();
    expect(budgetNote(40, meter.snapshot())).toMatch(
      /^GitHub's API budget has 12 requests left until \d\d:\d\d, and these 40 changes need at least 40\./,
    );
  });
});

describe('the redrawn line on a terminal', () => {
  test('stays one column inside the terminal, so it never wraps', async () => {
    const written: string[] = [];
    let release: () => void = () => {};
    const done = reportProgress(
      'Reading live state',
      new RequestMeter(),
      () => new Promise<void>((resolve) => (release = resolve)),
      { write: (text: string) => written.push(text), isTTY: true, columns: 30 },
    );
    release();
    await done;
    const clear = '\r\x1b[2K';
    const redraws = written.filter((w) => w.startsWith(clear) && w.length > clear.length);
    expect(redraws.length).toBeGreaterThan(0);
    for (const redraw of redraws) {
      expect(redraw.slice(clear.length).length).toBeLessThanOrEqual(29);
      expect(redraw.endsWith('…')).toBe(true);
    }
  });

  test('fitToWidth leaves a short line alone and marks a cut one', () => {
    expect(fitToWidth('short', 10)).toBe('short');
    expect(fitToWidth('a longer line', 8)).toBe('a longe…');
  });
});

describe('since', () => {
  const now = Date.UTC(2026, 9, 4, 14, 0);
  const before = (ms: number) => new Date(now - ms).toISOString();

  test('is relative within a day', () => {
    expect(since(before(20_000), now)).toBe('just now');
    expect(since(before(60_000), now)).toBe('1 minute ago');
    expect(since(before(42 * 60_000), now)).toBe('42 minutes ago');
    expect(since(before(60 * 60_000), now)).toBe('1 hour ago');
    expect(since(before(23 * 60 * 60_000), now)).toBe('23 hours ago');
  });

  test('is a local date and time after a day', () => {
    const at = new Date(now - 3 * 24 * 60 * 60_000);
    expect(since(at.toISOString(), now)).toBe(
      `on ${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${clock(at)}`,
    );
  });

  test('treats a time ahead of the clock as just now, and passes an unparsable one through', () => {
    expect(since(before(-5 * 60_000), now)).toBe('just now');
    expect(since('yesterday-ish', now)).toBe('yesterday-ish');
  });
});
