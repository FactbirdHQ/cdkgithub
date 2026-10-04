/**
 * Points `package.json` at the compiled `dist/` for the npm package. The
 * committed manifest points at the TypeScript sources, which is what a
 * dependency on the git repository installs, untranspiled. The npm package
 * must run on Node, which refuses to strip types under `node_modules`, so it
 * ships JavaScript.
 *
 * Run after `bun run compile`, in the release job only.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = 'package.json';
const manifest = JSON.parse(readFileSync(path, 'utf8'));

manifest.exports = {
  '.': {
    types: './dist/src/index.d.ts',
    default: './dist/src/index.js',
  },
};
manifest.bin = { cdkgithub: 'dist/bin/cdkgithub.js' };
manifest.files = ['dist'];

writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
