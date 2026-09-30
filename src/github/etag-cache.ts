import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The cache file's format. A file of any other version is discarded on open,
 * which is how bodies saved by an earlier, wrong version stop being served.
 */
const CACHE_VERSION = 2;

/** Marks a response the cache answered, for whoever counts requests. */
export const CACHE_HIT_HEADER = 'x-cdkgithub-cache';

/** A GET response as GitHub last sent it, with the ETag that names that version. */
export interface CachedResponse {
  readonly etag: string;
  readonly data: unknown;
  /** The pagination header, which a 304 does not promise to repeat. */
  readonly link?: string;
}

/**
 * GET responses kept between runs so they can be asked for conditionally.
 *
 * GitHub answers a request carrying the ETag it last sent with a 304 when
 * nothing changed, and a 304 to an authorized request costs nothing from the
 * primary rate limit. A second plan against an unchanged organization then
 * spends almost none of the budget.
 *
 * Entries are keyed by the full URL, query included, and each token gets a file
 * of its own, so one token is never answered with what another was shown. The
 * file holds what the live read already holds, the same data the backups under
 * the same directory keep.
 */
export class EtagCache {
  private readonly entries: Map<string, CachedResponse>;
  private dirty = false;

  constructor(
    private readonly path?: string,
    entries: Iterable<[string, CachedResponse]> = [],
  ) {
    this.entries = new Map(entries);
  }

  /**
   * The cache for `token` under `dir`. A missing, unreadable or outdated file
   * starts an empty cache: the cost of losing one is a full-price read, not a
   * wrong one.
   */
  static open(dir: string, token: string): EtagCache {
    const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 16);
    const path = join(dir, 'cache', `etags-${fingerprint}.json`);
    if (!existsSync(path)) return new EtagCache(path);
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as {
        version?: number;
        entries?: Record<string, CachedResponse>;
      };
      if (stored.version !== CACHE_VERSION || !stored.entries) return new EtagCache(path);
      return new EtagCache(path, Object.entries(stored.entries));
    } catch {
      return new EtagCache(path);
    }
  }

  get(url: string): CachedResponse | undefined {
    return this.entries.get(url);
  }

  set(url: string, response: CachedResponse): void {
    this.entries.set(url, response);
    this.dirty = true;
  }

  /** Write the cache if anything changed, replacing the file in one rename. */
  save(): void {
    if (!this.path || !this.dirty) return;
    mkdirSync(join(this.path, '..'), { recursive: true });
    const partial = `${this.path}.partial`;
    writeFileSync(
      partial,
      JSON.stringify({ version: CACHE_VERSION, entries: Object.fromEntries(this.entries) }),
    );
    renameSync(partial, this.path);
    this.dirty = false;
  }
}
