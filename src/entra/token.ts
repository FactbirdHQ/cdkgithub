import { spawnSync } from 'node:child_process';

/**
 * Resolve a Microsoft Graph access token, in order of preference:
 *   1. `AZURE_GRAPH_TOKEN` environment variable
 *   2. `az account get-access-token` (the Azure CLI's signed-in identity)
 *
 * Throws if neither is available. The token stays in memory; nothing here
 * writes it anywhere.
 */
export function resolveGraphToken(): string {
  const fromEnv = process.env.AZURE_GRAPH_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // Bounded so a credential prompt hangs the CLI for ten seconds, not forever.
  const result = spawnSync(
    'az',
    [
      'account',
      'get-access-token',
      '--resource',
      'https://graph.microsoft.com',
      '--query',
      'accessToken',
      '--output',
      'tsv',
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const detail = result.stderr?.trim();
  throw new Error(
    'No Microsoft Graph token found. Set AZURE_GRAPH_TOKEN, or run ' +
      `\`az login\` so \`az account get-access-token\` works.${detail ? ` (az said: ${detail})` : ''}`,
  );
}
