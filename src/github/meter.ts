/**
 * What the client has asked GitHub for, and how much of GitHub's hourly
 * budget is left.
 *
 * GitHub meters REST requests and GraphQL queries as separate budgets, each
 * reported in the headers of every response. Those headers are what GitHub
 * enforces, and the meter reads nothing else: `GET /rate_limit` has been seen
 * reporting a full budget while requests were being refused for an empty one.
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
  private readonly budgets: Partial<Record<RateResource, RateBudget>> = {};
  private readonly routes = new Map<string, number>();
  private waiting?: RateWait;
  /**
   * Called when a wait starts, or ends more than a minute past the current one.
   * Requests that hit a limit together each report a slightly later end, and
   * those are one wait to whoever is watching.
   */
  onWait?: (wait: RateWait) => void;

  /** Count one response, error responses included, and read its rate headers. */
  record(
    route: string,
    headers: Record<string, string | number | undefined> | undefined,
  ): void {
    const resource: RateResource =
      route.endsWith(' /graphql') || headers?.['x-ratelimit-resource'] === 'graphql'
        ? 'graphql'
        : 'core';
    this.requests[headers?.[CACHE_HIT_HEADER] === 'hit' ? 'cached' : resource] += 1;
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
    this.waiting = undefined;

    const remaining = Number(headers?.['x-ratelimit-remaining']);
    const limit = Number(headers?.['x-ratelimit-limit']);
    const reset = Number(headers?.['x-ratelimit-reset']);
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.setBudget(resource, {
        remaining,
        limit: Number.isFinite(limit) ? limit : remaining,
        resetsAt: new Date(reset * 1000),
      });
    }
  }

  private setBudget(resource: RateResource, budget: RateBudget): void {
    this.budgets[resource] = budget;
  }

  /** Note that a request is sitting out a rate limit for `seconds`. */
  wait(seconds: number, secondary: boolean): void {
    const until = new Date(Date.now() + seconds * 1000);
    if (
      !this.waiting ||
      until.getTime() - this.waiting.until.getTime() > 60_000
    ) {
      this.waiting = { secondary, until };
      this.onWait?.(this.waiting);
    }
  }

  snapshot(): MeterSnapshot {
    return {
      requests: { ...this.requests },
      budgets: { ...this.budgets },
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
