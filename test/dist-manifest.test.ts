import { describe, expect, test } from 'bun:test';

import { pointAtRepository } from '../cicd/dist-manifest.ts';

const repository = { owner: 'FactbirdHQ', name: 'cdkgithub', ref: 'v1.0.0' };
const raw = 'https://raw.githubusercontent.com/FactbirdHQ/cdkgithub/v1.0.0';
const blob = 'https://github.com/FactbirdHQ/cdkgithub/blob/v1.0.0';

describe('the README npm publishes', () => {
  test('loads a relative image from the repository at the release tag', () => {
    expect(pointAtRepository('![demo](docs/demo/cdkgithub.gif)', repository)).toBe(
      `![demo](${raw}/docs/demo/cdkgithub.gif)`,
    );
    expect(pointAtRepository('<img src="./media/logo.png" alt="logo">', repository)).toBe(
      `<img src="${raw}/media/logo.png" alt="logo">`,
    );
  });

  test('links a relative path to its page on GitHub, keeping a title', () => {
    expect(pointAtRepository('[Reference](docs/reference.md "the reference")', repository)).toBe(
      `[Reference](${blob}/docs/reference.md "the reference")`,
    );
    expect(pointAtRepository('<a href="LICENSE">license</a>', repository)).toBe(
      `<a href="${blob}/LICENSE">license</a>`,
    );
  });

  test('leaves URLs, anchors and site-absolute paths as they are', () => {
    const untouched = [
      '[npm](https://www.npmjs.com/package/constructs)',
      '[Getting started](#getting-started)',
      '[mail](mailto:someone@example.com)',
      '![badge](https://img.shields.io/badge/x-y-blue)',
      '[root](/docs/how-to.md)',
    ].join('\n');
    expect(pointAtRepository(untouched, repository)).toBe(untouched);
  });
});
