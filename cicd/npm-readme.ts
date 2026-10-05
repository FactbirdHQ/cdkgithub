/**
 * Points the README's relative images and links at the GitHub repository for
 * the npm package. npmjs.com renders the README on its own domain, where a
 * path like `docs/demo/cdkgithub.gif` resolves to nothing. An image becomes
 * its raw file and a link its page on GitHub, both at the release's tag, so a
 * version's page shows what that version shipped with. The README in the
 * repository keeps its relative paths, which GitHub resolves itself.
 *
 * Run in the release job only, before `npm publish`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** Where a relative path points, for an image and for a link. */
export interface Repository {
  readonly owner: string;
  readonly name: string;
  readonly ref: string;
}

/** A path relative to the repository, not a URL, an anchor or a site-absolute path. */
const RELATIVE = /^(?![a-z][a-z0-9+.-]*:|#|\/)/i;

export function pointAtRepository(markdown: string, repository: Repository): string {
  const { owner, name, ref } = repository;
  const image = (path: string) => `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${clean(path)}`;
  const page = (path: string) => `https://github.com/${owner}/${name}/blob/${ref}/${clean(path)}`;
  const rewrite = (path: string, to: (path: string) => string) => (RELATIVE.test(path) ? to(path) : path);

  return (
    markdown
      // ![alt](path) and [text](path), with an optional "title" after the path.
      .replace(
        /(!?)\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g,
        (_, bang: string, text: string, path: string, title: string) =>
          `${bang}[${text}](${rewrite(path, bang ? image : page)}${title})`,
      )
      .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (_, before: string, path: string, after: string) => {
        return `${before}${rewrite(path, image)}${after}`;
      })
      .replace(/(<a\b[^>]*\bhref=")([^"]+)(")/g, (_, before: string, path: string, after: string) => {
        return `${before}${rewrite(path, page)}${after}`;
      })
  );
}

function clean(path: string): string {
  return path.replace(/^\.\//, '');
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(manifest.repository?.url ?? '');
  if (!match) {
    throw new Error(`package.json's repository.url is not a GitHub repository: ${manifest.repository?.url}`);
  }
  const repository = { owner: match[1]!, name: match[2]!, ref: `v${manifest.version}` };
  writeFileSync('README.md', pointAtRepository(readFileSync('README.md', 'utf8'), repository));
}
