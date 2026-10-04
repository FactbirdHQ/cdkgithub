import { Box, render, Static, Text } from 'ink';
import { useSyncExternalStore } from 'react';
import type { RateWait } from '../github/meter.ts';
import { clock } from '../progress.ts';
import type { Palette } from '../reconcile/color.ts';
import type { ApplyRecord } from '../reconcile/applier.ts';
import { useSpinner } from './terminal.ts';

export interface ApplyTask {
  readonly title: string;
  readonly notes: readonly string[];
  readonly status: 'running' | 'applied' | 'failed';
  readonly error?: string;
}

export interface ApplyTasksState {
  /** Tasks that have ended, in the order they ended. */
  readonly done: readonly ApplyTask[];
  readonly running?: ApplyTask;
  readonly waiting?: RateWait;
}

/**
 * The applier's callbacks as a list of tasks. The first progress message after
 * a record opens a task and later ones are notes on it, because a change can
 * report more than once while it runs. A record ends the open task. A skipped
 * change opens none, since the summary lists what was skipped and why.
 */
export class ApplyTasks {
  private state: ApplyTasksState = { done: [] };
  private readonly listeners = new Set<() => void>();

  progress(message: string): void {
    const running = this.state.running;
    this.set({
      ...this.state,
      running: running
        ? { ...running, notes: [...running.notes, message] }
        : { title: message, notes: [], status: 'running' },
      waiting: undefined,
    });
  }

  record(record: ApplyRecord): void {
    const running = this.state.running;
    if (!running || record.status === 'skipped') return;
    this.set({
      done: [
        ...this.state.done,
        {
          ...running,
          status: record.status,
          ...(record.error ? { error: record.error } : {}),
        },
      ],
      running: undefined,
      waiting: undefined,
    });
  }

  wait(wait: RateWait): void {
    this.set({ ...this.state, waiting: wait });
  }

  snapshot = (): ApplyTasksState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(state: ApplyTasksState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

function TaskLine({ task, palette, spinner }: { task: ApplyTask; palette: Palette; spinner?: string }) {
  const mark =
    task.status === 'running'
      ? palette.changed(spinner ?? '•')
      : task.status === 'applied'
        ? palette.added('✔')
        : palette.removed('✖');
  return (
    <Box flexDirection="column">
      <Text>
        {mark} {task.title}
      </Text>
      {task.notes.map((note, i) => (
        <Text key={i}>{palette.muted(`  ${note}`)}</Text>
      ))}
      {task.error && <Text>{palette.removed(`  ${task.error}`)}</Text>}
    </Box>
  );
}

function Running({ task, waiting, palette }: { task?: ApplyTask; waiting?: RateWait; palette: Palette }) {
  const spinner = useSpinner();
  return (
    <Box flexDirection="column">
      {task && <TaskLine task={task} palette={palette} spinner={spinner} />}
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

export function ApplyTasksView({ tasks, palette }: { tasks: ApplyTasks; palette: Palette }) {
  const state = useSyncExternalStore(tasks.subscribe, tasks.snapshot);
  return (
    <>
      <Static items={[...state.done]}>
        {(task, i) => <TaskLine key={i} task={task} palette={palette} />}
      </Static>
      {(state.running || state.waiting) && (
        <Running task={state.running} waiting={state.waiting} palette={palette} />
      )}
    </>
  );
}

/** Draw `tasks` until `stop` is called, leaving every ended task in the scrollback. */
export function showApplyTasks(tasks: ApplyTasks, palette: Palette): { stop(): void } {
  const screen = render(<ApplyTasksView tasks={tasks} palette={palette} />, {
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return {
    stop() {
      screen.unmount();
    },
  };
}
