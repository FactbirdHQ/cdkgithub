import { spawnSync } from 'node:child_process';

/**
 * Resolve a GitHub token, in order of preference:
 *   1. `GITHUB_TOKEN` / `GH_TOKEN` environment variables
 *   2. `gh auth token` (the GitHub CLI's stored credential)
 *
 * Throws if neither is available.
 */
export function resolveToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }

  // Bounded so a credential helper waiting for input hangs the CLI for ten
  // seconds, not forever.
  const result = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const detail = result.stderr?.trim();
  throw new Error(
    'No GitHub token found. Set GITHUB_TOKEN, or run `gh auth login` so ' +
      `\`gh auth token\` works.${detail ? ` (gh said: ${detail})` : ''}`,
  );
}
