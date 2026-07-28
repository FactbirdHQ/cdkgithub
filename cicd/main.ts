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
    {
      name: 'Workflows in sync',
      run: 'bun run synth:workflows && git diff --exit-code .github/workflows',
    },
  ],
});

app.synth();
