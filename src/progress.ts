import type { MeterSnapshot, RateWait, RequestMeter } from './github/meter.ts';

/** Where progress goes, and whether it may rewrite its last line. */
export interface ProgressStream {
  write(text: string): unknown;
  readonly isTTY?: boolean;
  /** The terminal's width, which a redrawn line must stay inside. */
  readonly columns?: number;
}

/** How often a terminal redraws the line, and how often a log gets a new one. */
const TTY_INTERVAL_MS = 250;
const LOG_INTERVAL_MS = 15_000;

/**
 * Run `work` while reporting how far it has got.
 *
 * A terminal gets one line redrawn in place. A log, such as a CI run, gets a
 * line every fifteen seconds and one as soon as a rate limit starts being
 * waited out, so a long read never goes quiet. Either way the read ends with
 * a summary of what it cost.
 */
export async function reportProgress<T>(
  label: string,
  meter: RequestMeter,
  work: () => Promise<T>,
  stream: ProgressStream = process.stderr,
  now: () => number = Date.now,
  verbose = false,
): Promise<T> {
  const started = now();
  const line = () => progressLine(label, meter.snapshot(), now() - started, now());

  let announcedWait: number | undefined;
  const tick = () => {
    if (stream.isTTY) {
      // A line wider than the terminal wraps, and returning to the start of
      // the row then redraws below the rows it wrapped onto instead of over
      // them. Cut to one column short of the width, so the cursor never wraps.
      stream.write(`\r\x1b[2K${fit(line(), (stream.columns ?? 80) - 1)}`);
      return;
    }
    const waiting = meter.snapshot().waiting?.until.getTime();
    if (waiting !== undefined && waiting !== announcedWait) {
      announcedWait = waiting;
      stream.write(`${line()}\n`);
    }
  };
  const timers = [setInterval(tick, stream.isTTY ? TTY_INTERVAL_MS : 1000)];
  if (!stream.isTTY) {
    timers.push(setInterval(() => stream.write(`${line()}\n`), LOG_INTERVAL_MS));
  }
  tick();

  try {
    const result = await work();
    finish();
    stream.write(`${summaryLine(label, meter, now() - started, verbose)}\n`);
    return result;
  } catch (error) {
    finish();
    throw error;
  }

  function finish() {
    for (const timer of timers) clearInterval(timer);
    if (stream.isTTY) stream.write('\r\x1b[2K');
  }
}

/** `text` cut to `width` characters, marking the cut with an ellipsis. */
export function fit(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, Math.max(width, 0)) : `${text.slice(0, width - 1)}…`;
}

/** The status line shown while a read is under way. */
export function progressLine(
  label: string,
  snapshot: MeterSnapshot,
  elapsedMs: number,
  nowMs: number,
): string {
  const parts = [
    `${label}: ${requestCounts(snapshot)}, ${duration(elapsedMs)}`,
  ];
  const core = snapshot.budgets.core;
  if (snapshot.waiting) {
    const kind = snapshot.waiting.secondary ? 'secondary rate limit' : 'rate limit';
    parts.push(
      `waiting out GitHub's ${kind} until ${clock(snapshot.waiting.until)}`,
    );
  } else if (core && core.remaining === 0 && core.resetsAt.getTime() > nowMs) {
    parts.push(`REST budget spent until ${clock(core.resetsAt)}`);
  } else if (core) {
    parts.push(`${core.remaining.toLocaleString('en-US')} REST requests left`);
  }
  return parts.join(' · ');
}

/**
 * The line a finished read leaves behind: how long it took and the budget
 * left. `verbose` adds what it asked GitHub for and the routes it asked most.
 */
export function summaryLine(
  label: string,
  meter: RequestMeter,
  elapsedMs: number,
  verbose = false,
): string {
  const snapshot = meter.snapshot();
  const core = snapshot.budgets.core;
  const budget = core
    ? ` REST budget: ${core.remaining.toLocaleString('en-US')} of ${core.limit.toLocaleString('en-US')} left`
    : '';
  if (!verbose) {
    return `${label} took ${duration(elapsedMs)}.${budget && `${budget}.`}`;
  }
  const busiest = meter
    .busiest(3)
    .map((r) => `${r.route} (${r.requests})`)
    .join(', ');
  return [
    `${label} took ${duration(elapsedMs)} and ${requestCounts(snapshot)}.`,
    busiest ? ` Most requested: ${busiest}.` : '',
    core ? `${budget}, refilled at ${clock(core.resetsAt)}.` : '',
  ].join('');
}

/**
 * A note for an apply whose writes may not fit in the REST budget left, or
 * undefined when they do. Each change is at least one request, so the count
 * is a floor.
 */
export function budgetNote(
  changes: number,
  snapshot: MeterSnapshot,
): string | undefined {
  const core = snapshot.budgets.core;
  if (!core || core.remaining >= changes) return undefined;
  return (
    `GitHub's REST budget has ${core.remaining.toLocaleString('en-US')} requests left until ` +
    `${clock(core.resetsAt)}, and these ${changes} changes need at least ${changes}. ` +
    `apply pauses when the budget runs out and carries on at ${clock(core.resetsAt)}.`
  );
}

export function requestCounts(snapshot: MeterSnapshot): string {
  const { core, graphql, cached } = snapshot.requests;
  const counts = `${core} REST request${core === 1 ? '' : 's'}, ${graphql} GraphQL quer${graphql === 1 ? 'y' : 'ies'}`;
  return cached > 0 ? `${counts}, ${cached} unchanged and free` : counts;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/** The line printed when a write starts waiting out a rate limit. */
export function waitLine(wait: RateWait): string {
  const kind = wait.secondary ? 'secondary rate limit' : 'rate limit';
  return `  waiting out GitHub's ${kind} until ${clock(wait.until)}`;
}

/** A wall-clock time in the reader's own zone, to the minute. */
export function clock(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
