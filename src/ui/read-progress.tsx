import { Box, render, Text } from 'ink';
import type { MeterSnapshot, RateBudget, RequestMeter } from '../github/meter.ts';
import { clock, duration, requestCounts, summaryLine } from '../progress.ts';
import type { Palette } from '../reconcile/color.ts';
import { useSpinner, useTick } from './terminal.ts';

const BAR_WIDTH = 16;

/** How much of `budget` is left, as a bar `BAR_WIDTH` cells wide. */
export function budgetBar(budget: RateBudget): string {
  const share = budget.limit > 0 ? budget.remaining / budget.limit : 0;
  const filled = Math.round(Math.min(Math.max(share, 0), 1) * BAR_WIDTH);
  return `▕${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}▏`;
}

export function ReadProgressView({
  label,
  snapshot,
  elapsedMs,
  nowMs,
  palette,
}: {
  label: string;
  snapshot: MeterSnapshot;
  elapsedMs: number;
  nowMs: number;
  palette: Palette;
}) {
  const spinner = useSpinner();
  const core = snapshot.budgets.core;
  const spent = core !== undefined && core.remaining === 0 && core.resetsAt.getTime() > nowMs;
  const waiting = snapshot.waiting;
  return (
    <Box flexDirection="column">
      <Text>
        {palette.changed(spinner)} {label}  {palette.muted(`${requestCounts(snapshot)} · ${duration(elapsedMs)}`)}
      </Text>
      {core && (
        <Text>
          {'  REST budget '}
          {spent
            ? palette.removed(`spent until ${clock(core.resetsAt)}`)
            : `${budgetBar(core)} ${core.remaining.toLocaleString('en-US')} of ${core.limit.toLocaleString('en-US')} left`}
        </Text>
      )}
      {waiting && (
        <Text>
          {palette.changed(
            `  waiting out GitHub's ${waiting.secondary ? 'secondary rate limit' : 'rate limit'} until ${clock(waiting.until)}`,
          )}
        </Text>
      )}
    </Box>
  );
}

function ReadProgress({
  label,
  meter,
  started,
  palette,
}: {
  label: string;
  meter: RequestMeter;
  started: number;
  palette: Palette;
}) {
  useTick(250);
  const now = Date.now();
  return (
    <ReadProgressView
      label={label}
      snapshot={meter.snapshot(now)}
      elapsedMs={now - started}
      nowMs={now}
      palette={palette}
    />
  );
}

/**
 * Run `work` under a live view of what it has asked GitHub for, then leave the
 * same summary line a log gets.
 */
export async function readWithScreen<T>(
  label: string,
  meter: RequestMeter,
  work: () => Promise<T>,
  palette: Palette,
  verbose = false,
  stream: NodeJS.WriteStream = process.stderr,
): Promise<T> {
  const started = Date.now();
  const screen = render(
    <ReadProgress label={label} meter={meter} started={started} palette={palette} />,
    { stdout: stream, patchConsole: false, exitOnCtrlC: false },
  );
  try {
    const result = await work();
    screen.clear();
    screen.unmount();
    stream.write(`${summaryLine(label, meter, Date.now() - started, verbose)}\n`);
    return result;
  } catch (error) {
    screen.clear();
    screen.unmount();
    throw error;
  }
}
