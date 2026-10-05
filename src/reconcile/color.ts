/**
 * The colors the tree diff is printed in, and when to use them.
 *
 * A palette is a set of functions from text to text, so the renderer marks up
 * meaning rather than escape codes and the plain palette is the identity. That
 * is what keeps the uncolored output byte-for-byte what it was, and what lets
 * the render tests assert on text instead of on escapes.
 */

/** Text decoration by meaning, not by color name. */
export interface Palette {
  /** Something the definition has and GitHub does not. */
  added(text: string): string;
  /** Something GitHub has and the definition does not. */
  removed(text: string): string;
  /** Something both have, differently. */
  changed(text: string): string;
  /** Context: counts, hints, and the teams that match. */
  muted(text: string): string;
}

const identity = (text: string): string => text;

/** No decoration at all, for a pipe, a file, or `NO_COLOR`. */
export const PLAIN: Palette = {
  added: identity,
  removed: identity,
  changed: identity,
  muted: identity,
};

const wrap =
  (code: string) =>
  (text: string): string =>
    `\x1b[${code}m${text}\x1b[0m`;

/**
 * Green adds, red removes, yellow changes, dim context.
 *
 * The three change colors are the 16-color codes rather than 256-color or true
 * color, because every terminal has them and every terminal theme has already
 * remapped them to something readable on its own background.
 */
export const ANSI: Palette = {
  added: wrap('32'),
  removed: wrap('31'),
  changed: wrap('33'),
  muted: wrap('2'),
};

/** What the environment says about color, for {@link choosePalette}. */
export interface ColorEnvironment {
  /** `--color`, `--no-color`, or neither. */
  readonly flag?: 'always' | 'never';
  /** Whether the stream being written to is a terminal. */
  readonly isTTY?: boolean;
  readonly env?: Record<string, string | undefined>;
}

/**
 * Whether to color, in the order the conventions take precedence.
 *
 * An explicit flag wins, then `NO_COLOR`, then `FORCE_COLOR`, then whether the
 * output is going to a terminal at all. `NO_COLOR` counts when it is set to
 * anything but the empty string, which is what https://no-color.org asks for,
 * and it beats `FORCE_COLOR` so that the refusal is the one that is hard to
 * override by accident. A `dumb` terminal is not one, whatever it claims.
 */
export function choosePalette(environment: ColorEnvironment = {}): Palette {
  const { flag, isTTY = false, env = {} } = environment;

  if (flag === 'never') {
    return PLAIN;
  }
  if (flag === 'always') {
    return ANSI;
  }
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return PLAIN;
  }
  if (env.TERM === 'dumb') {
    return PLAIN;
  }
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') {
    return ANSI;
  }
  return isTTY ? ANSI : PLAIN;
}
