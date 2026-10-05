import { Box, render, Text, useApp, useInput } from 'ink';
import { useEffect, useState } from 'react';

import type { Palette } from '../reconcile/color.ts';

/** What the person pressed: `y` approves, anything that ends the prompt otherwise declines. */
export function answerFor(
  input: string,
  key: { return?: boolean; escape?: boolean; ctrl?: boolean },
): boolean | undefined {
  if (key.ctrl && input === 'c') {
    return false;
  }
  if (key.return || key.escape) {
    return false;
  }
  const letter = input.toLowerCase();
  if (letter === 'y') {
    return true;
  }
  if (letter === 'n') {
    return false;
  }
  return undefined;
}

export function ApprovalPrompt({
  changes,
  destructive,
  palette,
  onAnswer,
}: {
  changes: number;
  destructive: number;
  palette: Palette;
  onAnswer: (approved: boolean) => void;
}) {
  const { exit } = useApp();
  const [answer, setAnswer] = useState<boolean>();
  useInput(
    (input, key) => {
      const approved = answerFor(input, key);
      if (approved === undefined) {
        return;
      }
      setAnswer(approved);
      onAnswer(approved);
    },
    { isActive: answer === undefined },
  );
  // Exits once the answer has been drawn, so it stays on the screen.
  useEffect(() => {
    if (answer !== undefined) {
      exit();
    }
  }, [answer, exit]);
  const destructiveText = `${destructive} destructive`;
  return (
    <Box borderStyle="round" paddingX={1} flexDirection="column" alignSelf="flex-start">
      <Text>
        {changes} change{changes === 1 ? '' : 's'} to apply,{' '}
        {destructive > 0 ? palette.removed(destructiveText) : destructiveText}.
      </Text>
      <Text>
        Do you wish to apply these changes?{' '}
        {answer === undefined ? palette.muted('(y/N)') : answer ? palette.added('yes') : palette.removed('no')}
      </Text>
    </Box>
  );
}

/** Ask on the terminal whether to apply, with no as the default. */
export async function confirmApply(changes: number, destructive: number, palette: Palette): Promise<boolean> {
  let approved = false;
  const screen = render(
    <ApprovalPrompt
      changes={changes}
      destructive={destructive}
      palette={palette}
      onAnswer={(a) => {
        approved = a;
      }}
    />,
    { exitOnCtrlC: false, patchConsole: false },
  );
  await screen.waitUntilExit();
  return approved;
}
