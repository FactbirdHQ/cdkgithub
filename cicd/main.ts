/**
 * CI workflow for cdkgithub, defined with @factbird/cdkactions and synthesized
 * to `.github/workflows/`.
 *
 * Regenerate after editing:  bun run synth:workflows
 * (CI fails if the committed YAML drifts from this definition.)
 *
 * CI only *synthesizes the structure* — it typechecks, runs the unit tests
 * (which exercise the plan/apply surface against an in-memory GitHub fake), and
 * builds the desired-state manifest from the org definition. It deliberately
 * does NOT run `plan`/`apply` against the live org:
 *
 *   - `apply` would impose this repo's structure on the real organization, which
 *     is not desired — the org is the source of truth we reconcile *towards*
 *     intentionally, not on every push.
 *   - end-to-end apply testing wants a throwaway sandbox org. When one exists,
 *     add a manual (workflow_dispatch) job that mints a short-lived token with
 *     `createGithubAppTokenV3` and runs `plan`/`apply` against the sandbox only.
 */
import {
  App,
  checkoutV4,
  Job,
  RunnerLabel,
  setupNodeV6,
  Stack,
  Workflow,
} from '@factbird/cdkactions';

const app = new App({
  outdir: '.github/workflows',
  // The built-in validate workflow assumes a `.github/cdk` + yarn layout; our
  // definition lives in `cicd/` and the `verify` job already checks for drift.
  createValidateWorkflow: false,
});
const stack = new Stack(app, 'cdkgithub');

const ci = new Workflow(stack, 'ci', {
  name: 'CI',
  on: {
    pullRequest: { branches: ['main'] },
    push: { branches: ['main'] },
  },
  permissions: { contents: 'read' },
});

new Job(ci, 'verify', {
  runsOn: RunnerLabel.UBUNTU_LATEST,
  steps: [
    checkoutV4(),
    {
      name: 'Setup Bun',
      uses: 'oven-sh/setup-bun@v2',
      with: { 'bun-version': 'latest' },
    },
    { name: 'Install', run: 'bun install --frozen-lockfile' },
    { name: 'Typecheck', run: 'bun run build' },
    // Unit tests cover the plan/apply surface with an in-memory GitHub fake.
    { name: 'Test', run: 'bun test' },
    // Synthesize the desired-state manifest from the org definition.
    {
      name: 'Synth manifest',
      run: 'bun bin/cdkgithub.ts synth examples/factbird.ts',
    },
    { name: 'Compile', run: 'bun run compile' },
    {
      name: 'Workflows in sync',
      run: 'bun run synth:workflows && git diff --exit-code .github/workflows',
    },
  ],
});

/**
 * Publishes to npm when a GitHub release is published. npm trusts this
 * workflow's OIDC token, so no npm token is stored anywhere. The package's
 * trusted publisher on npmjs.com names this repository, the workflow file
 * `cdkactions_release.yaml` and the environment `npm`, and a token minted by
 * any other workflow or environment is refused.
 */
const release = new Workflow(stack, 'release', {
  name: 'Release',
  on: { release: { types: ['published'] } },
  permissions: { contents: 'read' },
});

new Job(release, 'publish', {
  runsOn: RunnerLabel.UBUNTU_LATEST,
  environment: 'npm',
  // Two releases published together still publish one after the other.
  concurrency: { group: 'npm-publish', cancelInProgress: false },
  permissions: { contents: 'read', idToken: 'write' },
  steps: [
    checkoutV4(),
    {
      name: 'Setup Bun',
      uses: 'oven-sh/setup-bun@v2',
      with: { 'bun-version': 'latest' },
    },
    { name: 'Install', run: 'bun install --frozen-lockfile' },
    { name: 'Typecheck', run: 'bun run build' },
    { name: 'Test', run: 'bun test' },
    // Trusted publishing needs Node 22.14 and npm 11.5.1 or later.
    setupNodeV6({
      id: 'node',
      with: { nodeVersion: '24', registryUrl: 'https://registry.npmjs.org' },
    }),
    { name: 'Update npm', run: 'npm install --global npm@^11.5.1' },
    {
      name: 'Release tag matches package.json',
      env: { TAG: '${{ github.event.release.tag_name }}' },
      run: [
        'VERSION="v$(node -p "require(\'./package.json\').version")"',
        'if [ "$TAG" != "$VERSION" ]; then',
        '  echo "::error::Release tag $TAG does not match package.json version $VERSION"',
        '  exit 1',
        'fi',
      ].join('\n'),
    },
    // prepack compiles dist/, and npm attaches provenance on its own.
    { name: 'Publish', run: 'npm publish' },
  ],
});

app.synth();
