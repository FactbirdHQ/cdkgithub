/**
 * When the terminal screens may run, and what they share.
 *
 * A screen redraws itself, so it runs only where a person watches it redraw:
 * a terminal that is not CI's log and not `dumb`. Everywhere else the CLI
 * prints the plain lines a log keeps, and never loads React.
 */

import { useEffect, useState } from 'react';

/** Whether `stream` is a terminal a screen may redraw. */
export function interactive(
  stream: { readonly isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (stream.isTTY !== true) {
    return false;
  }
  if (env.TERM === 'dumb') {
    return false;
  }
  return env.CI === undefined || env.CI === '' || env.CI === 'false';
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** The spinner's current frame, advancing while the component is mounted. */
export function useSpinner(intervalMs = 80): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return SPINNER[frame]!;
}

/** Re-render every `intervalMs`, for a view that reads from something mutable. */
export function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}
