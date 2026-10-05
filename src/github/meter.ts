/**
 * What the client has asked GitHub for, and how much of GitHub's hourly
 * budget is left.
 *
 * GitHub meters REST requests and GraphQL queries as separate budgets, each
 * reported in the headers of every response. Those headers are what GitHub
 * enforces, and the meter reads nothing else: `GET /rate_limit` has been seen
 * reporting a full budget while requests were being refused for an empty one.
 *
 * One token can hold more than one budget under the same resource name.
 * GitHub answers some routes from a budget that refills at one time and the
 * rest from another that refills at another, each with its own count, and
 * responses arrive out of order. So the meter keeps the lowest count seen
 * for each refill time and reports the budget with the least left, the one
 * that runs out first.
 * A reader of the meter can show progress, say when a limit is being waited
 * out, and judge whether a set of writes fits in what remains.
 */

import { CACHE_HIT_HEADER } from './etag-cache.ts';

/** A budget GitHub meters on its own: `core` for REST, `graphql` for GraphQL. */
export type RateResource = 'core' | 'graphql';

export interface RateBudget {
  readonly remaining: number;
  readonly limit: number;
  /** When GitHub refills the budget. */
  readonly resetsAt: Date;
}

/** A rate limit the client is sitting out before it retries. */
export interface RateWait {
  readonly secondary: boolean;
  readonly until: Date;
}

export interface MeterSnapshot {
  /** GitHub's metered requests, and the `cached` ones answered with a free 304. */
  readonly requests: Record<RateResource | 'cached', number>;
  readonly budgets: Partial<Record<RateResource, RateBudget>>;
  /** Set while at least one request is waiting out a rate limit. */
  readonly waiting?: RateWait;
}

export class RequestMeter {
  private readonly requests: Record<RateResource | 'cached', number> = {
    core: 0,
    graphql: 0,
    cached: 0,
  };
  /** Each budget by the time it refills, in epoch seconds. */
  private readonly budgets: Record<RateResource, Map<number, RateBudget>> = {
    core: new Map(),
    graphql: new Map(),
  };
  private readonly routes = new Map<string, number>();
  private waiting?: RateWait;
  /**
   * Called when a wait starts, or ends more than a minute past the current one.
   * Requests that hit a limit together each report a slightly later end, and
   * those are one wait to whoever is watching.
   */
  onWait?: (wait: RateWait) => void;

  /** Count one response, error responses included, and read its rate headers. */
  record(route: string, headers: Record<string, string | number | undefined> | undefined): void {
    const resource: RateResource =
      route.endsWith(' /graphql') || headers?.['x-ratelimit-resource'] === 'graphql' ? 'graphql' : 'core';
    this.requests[headers?.[CACHE_HIT_HEADER] === 'hit' ? 'cached' : resource] += 1;
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
    this.waiting = undefined;

    const remaining = Number(headers?.['x-ratelimit-remaining']);
    const limit = Number(headers?.['x-ratelimit-limit']);
    const reset = Number(headers?.['x-ratelimit-reset']);
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      const seen = this.budgets[resource].get(reset);
      if (!seen || remaining < seen.remaining) {
        this.budgets[resource].set(reset, {
          remaining,
          limit: Number.isFinite(limit) ? limit : remaining,
          resetsAt: new Date(reset * 1000),
        });
      }
    }
  }

  /**
   * The budget with the least left among those not yet refilled, or the one
   * that refills last when every budget has.
   */
  private budget(resource: RateResource, nowMs: number): RateBudget | undefined {
    const budgets = [...this.budgets[resource].values()];
    const pending = budgets.filter((b) => b.resetsAt.getTime() > nowMs);
    if (pending.length > 0) {
      return pending.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    }
    return budgets.reduce<RateBudget | undefined>((a, b) => (!a || b.resetsAt > a.resetsAt ? b : a), undefined);
  }

  /** Note that a request is sitting out a rate limit for `seconds`. */
  wait(seconds: number, secondary: boolean): void {
    const until = new Date(Date.now() + seconds * 1000);
    if (!this.waiting || until.getTime() - this.waiting.until.getTime() > 60_000) {
      this.waiting = { secondary, until };
      this.onWait?.(this.waiting);
    }
  }

  snapshot(nowMs = Date.now()): MeterSnapshot {
    const budgets: Partial<Record<RateResource, RateBudget>> = {};
    for (const resource of ['core', 'graphql'] as const) {
      const budget = this.budget(resource, nowMs);
      if (budget) {
        budgets[resource] = budget;
      }
    }
    return {
      requests: { ...this.requests },
      budgets,
      ...(this.waiting ? { waiting: this.waiting } : {}),
    };
  }

  /** The routes asked for most, busiest first, as `METHOD /path/{template}`. */
  busiest(count: number): Array<{ route: string; requests: number }> {
    return [...this.routes]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([route, requests]) => ({ route, requests }));
  }
}
