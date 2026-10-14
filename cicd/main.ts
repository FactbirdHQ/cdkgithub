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
  checkoutV7,
  createPullRequestV8,
  DependabotActionPinSync,
  Job,
  nixInstallerActionV23,
  RunnerLabel,
  Stack,
  setupBunV2,
  setupNodeV6,
  Workflow,
} from '@factbird/cdkactions';

/**
 * A third-party action runs by commit, not by tag: whoever controls the tag
 * can move it, and the release job holds a token that publishes to npm.
 */
const setupBun = setupBunV2.pinned(
  '0c5077e51419868618aeaa5fe8019c62421857d6',
  'v2.2.0',
)({
  name: 'Setup Bun',
  with: { bunVersion: 'latest' },
});

const checkout = checkoutV7.pinned('3d3c42e5aac5ba805825da76410c181273ba90b1', 'v7.0.1')({});

const setupNode = setupNodeV6.pinned('949feb2413d6458794dcd2491c4babbbce0c15c1', 'v7.1.0');

/**
 * A named image rather than `ubuntu-latest`, so the image a job runs on changes
 * only through a change here.
 */
const runner = RunnerLabel.custom('ubuntu-26.04');

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
  runsOn: runner,
  steps: [
    checkout,
    setupBun,
    { name: 'Install', run: 'bun install --frozen-lockfile' },
    { name: 'Typecheck', run: 'bun run build' },
    // Unit tests cover the plan/apply surface with an in-memory GitHub fake.
    { name: 'Test', run: 'bun test' },
    // Synthesize the desired-state manifest from the org definition.
    {
      name: 'Synth manifest',
      run: 'bun src/bin/cdkgithub.ts synth examples/factbird.ts',
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
  runsOn: runner,
  environment: 'npm',
  // Two releases published together still publish one after the other.
  concurrency: { group: 'npm-publish', cancelInProgress: false },
  permissions: { contents: 'read', idToken: 'write' },
  steps: [
    checkout,
    setupBun,
    { name: 'Install', run: 'bun install --frozen-lockfile' },
    { name: 'Typecheck', run: 'bun run build' },
    { name: 'Test', run: 'bun test' },
    // Trusted publishing needs Node 22.14 and npm 11.5.1 or later.
    setupNode({
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
    { name: 'Compile', run: 'bun run compile' },
    { name: 'Prepare the npm package', run: 'bun cicd/dist-manifest.ts' },
    // npm attaches provenance on its own.
    { name: 'Publish', run: 'npm publish' },
  ],
});

/**
 * Monthly, because devenv-nixpkgs moves its rolling branch about once a month,
 * after devenv's own suite passes on it.
 *
 * The repository is public, so the organization's GitHub App secrets do not
 * reach it and the pull request is opened with GITHUB_TOKEN. GitHub starts no
 * workflow for events caused by GITHUB_TOKEN, so CI runs on that pull request
 * only once someone pushes to it or closes and reopens it.
 */
const devenvUpdate = new Workflow(stack, 'devenv-update', {
  name: 'devenv update',
  on: {
    schedule: [{ cron: '0 6 1 * *' }],
    workflowDispatch: null,
  },
  permissions: { contents: 'read' },
});

new Job(devenvUpdate, 'update', {
  runsOn: runner,
  permissions: { contents: 'write', pullRequests: 'write' },
  steps: [
    checkout,
    nixInstallerActionV23.pinned(
      '3138316df39ed29be04236d7ffc686fa525866aa',
      'v23',
    )({
      name: 'Install Nix',
    }),
    { name: 'Install devenv', run: 'nix profile install nixpkgs#devenv' },
    { name: 'Update devenv.lock', run: 'devenv update' },
    createPullRequestV8.pinned(
      '5f6978faf089d4d20b00c7766989d076bb2fc7f1',
      'v8.1.1',
    )({
      name: 'Open pull request',
      with: {
        branch: 'chore/devenv-update',
        addPaths: 'devenv.lock',
        commitMessage: 'chore: update devenv.lock',
        title: 'chore: update devenv.lock',
        body: [
          'Monthly `devenv update`, opened by the devenv update workflow.',
          '',
          'GitHub starts no workflow for a pull request opened with GITHUB_TOKEN, so push to this branch or close and reopen the pull request to run CI.',
        ].join('\n'),
        deleteBranch: true,
      },
    }),
  ],
});

new DependabotActionPinSync(stack, 'dependabot-action-pin-sync', {
  sources: ['cicd/main.ts'],
  synthCommand: 'bun run synth:workflows',
  setupSteps: [setupBun, { name: 'Install', run: 'bun install --frozen-lockfile' }],
  runsOn: runner,
});

app.synth();
