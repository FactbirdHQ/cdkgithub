/**
 * CI/CD workflows for cdkgithub, defined with @factbird/cdkactions and
 * synthesized to `.github/workflows/`.
 *
 * Regenerate after editing:  bun run synth:workflows
 * (CI fails if the committed YAML drifts from this definition.)
 *
 *   ci     — on PRs to main and pushes to main: typecheck, test, synth the org
 *            definition, verify workflows are in sync, then `plan` (read-only).
 *   apply  — on push to main and manual dispatch: reconcile the live org.
 *            Gated behind the `production` environment for approval.
 *
 * Auth: team/SCIM management needs org-admin scope, which the default
 * GITHUB_TOKEN lacks. Provide a PAT or GitHub App token as the repo/environment
 * secret ORG_ADMIN_TOKEN (see createGithubAppTokenV3 in cdkactions for the
 * App-token alternative).
 */
import {
  App,
  Job,
  RunnerLabel,
  Stack,
  Workflow,
  WorkflowDispatchInputType,
  checkoutV4,
  expression,
} from "@factbird/cdkactions";

const { secrets } = expression;

const app = new App({
  outdir: ".github/workflows",
  // The built-in validate workflow assumes a `.github/cdk` + yarn layout; our
  // definition lives in `cicd/` and the `ci` job already checks for drift.
  createValidateWorkflow: false,
});
const stack = new Stack(app, "cdkgithub");

/** Install Bun on the runner. */
const setupBun = {
  name: "Setup Bun",
  uses: "oven-sh/setup-bun@v2",
  with: { "bun-version": "latest" },
};

const install = { name: "Install", run: "bun install --frozen-lockfile" };
const synth = {
  name: "Synth manifest",
  run: "bun bin/cdkgithub.ts synth orgs/factbird.ts",
};

// Token for team/SCIM operations. Empty on events without the secret; the CLI
// then falls back to `gh auth token` (absent in CI) and fails loudly.
const orgTokenEnv = { GITHUB_TOKEN: `${secrets.ORG_ADMIN_TOKEN}` };

// --- CI: verify + plan -------------------------------------------------------
const ci = new Workflow(stack, "ci", {
  name: "CI",
  on: {
    pullRequest: { branches: ["main"] },
    push: { branches: ["main"] },
  },
  permissions: { contents: "read" },
});

new Job(ci, "verify", {
  runsOn: RunnerLabel.UBUNTU_LATEST,
  steps: [
    checkoutV4(),
    setupBun,
    install,
    { name: "Typecheck", run: "bun run build" },
    { name: "Test", run: "bun test" },
    synth,
    {
      name: "Workflows in sync",
      run: "bun run synth:workflows && git diff --exit-code .github/workflows",
    },
  ],
});

new Job(ci, "plan", {
  runsOn: RunnerLabel.UBUNTU_LATEST,
  steps: [
    checkoutV4(),
    setupBun,
    install,
    synth,
    {
      name: "Plan (read-only)",
      env: orgTokenEnv,
      run: "bun bin/cdkgithub.ts plan",
    },
  ],
});

// --- Apply -------------------------------------------------------------------
const applyWf = new Workflow(stack, "apply", {
  name: "Apply",
  on: {
    push: { branches: ["main"] },
    workflowDispatch: {
      inputs: {
        allowDelete: {
          type: WorkflowDispatchInputType.BOOLEAN,
          description: "Delete teams that are absent from the manifest",
          required: false,
          default: false,
        },
        enableScim: {
          type: WorkflowDispatchInputType.BOOLEAN,
          description: "Link teams to their Entra ID groups via SCIM",
          required: false,
          default: false,
        },
      },
    },
  },
  permissions: { contents: "read" },
  concurrency: { group: "cdkgithub-apply", cancelInProgress: false },
});

new Job(applyWf, "apply", {
  runsOn: RunnerLabel.UBUNTU_LATEST,
  environment: "production", // require reviewer approval before mutating the org
  steps: [
    checkoutV4(),
    setupBun,
    install,
    synth,
    {
      name: "Apply",
      env: {
        ...orgTokenEnv,
        // Empty strings on push events (no dispatch inputs) → safe defaults.
        ALLOW_DELETE: `${applyWf.inputs.allowDelete}`,
        ENABLE_SCIM: `${applyWf.inputs.enableScim}`,
      },
      run: [
        'FLAGS="--yes"',
        '[ "$ALLOW_DELETE" = "true" ] && FLAGS="$FLAGS --allow-delete"',
        '[ "$ENABLE_SCIM" = "true" ] && FLAGS="$FLAGS --enable-scim"',
        "bun bin/cdkgithub.ts apply $FLAGS",
      ].join("\n"),
    },
  ],
});

app.synth();
