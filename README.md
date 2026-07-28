# cdkgithub

Define your **GitHub organization's team structure as Infrastructure-as-Code**,
in the spirit of [AWS CDK](https://aws.amazon.com/cdk/). Teams, their hierarchy,
repo access, and their link to Entra ID security groups are declared in
TypeScript; the tool diffs that desired state against the live org and applies
the difference.

Built on the [`constructs`](https://www.npmjs.com/package/constructs) programming
model — the same standalone library that underpins `cdk8s` and `cdktf` — with a
custom synthesizer that targets the **GitHub REST API** (via Octokit) instead of
CloudFormation.

## Why

Team structure managed by hand in the GitHub UI drifts and isn't reviewable.
Here it lives in git: teams are code, changes go through pull requests, and
`plan` shows exactly what will happen before anything is touched.

## How it works

```
define   orgs/<org>.ts       new App / Organization / Team (+ externalGroup)
   │
synth    App.synth()         walk the construct tree → github.out/manifest.json
   │
plan     diff vs live org    read-only; prints a Terraform-style change preview
   │
apply    reconcile           create / update / (link) / delete to match desired
```

- **Nesting is the construct tree.** A `Team` scoped under another `Team` becomes
  a child team (GitHub `parent_team_id`); a team under the `Organization` is
  top-level.
- **Team identity is the slug** derived from its name. Renames are out of scope
  for v1 (a rename reads as delete + create).
- **Deletes are gated** behind `--allow-delete` so unmanaged teams aren't wiped
  by accident. **SCIM linking is gated** behind `--enable-scim`.

## Requirements

- [Bun](https://bun.sh) (package manager + runtime + test runner)
- A GitHub token: `GITHUB_TOKEN`/`GH_TOKEN`, or just be logged in with
  `gh auth login` (the CLI falls back to `gh auth token`). Needs org-admin scope
  to manage teams.

## Usage

```bash
bun install

# 1. Edit your org definition
$EDITOR orgs/factbird.ts

# 2. Synthesize the desired-state manifest
bun bin/cdkgithub.ts synth orgs/factbird.ts     # → github.out/manifest.json

# 3. Preview the diff against the live org (read-only)
bun bin/cdkgithub.ts plan

# 4. Apply. Without --yes this is a dry run.
bun bin/cdkgithub.ts apply --yes
bun bin/cdkgithub.ts apply --yes --allow-delete  # also remove unmanaged teams
bun bin/cdkgithub.ts apply --yes --enable-scim   # also link Entra groups (see below)
```

Scripts are also wired in `package.json`: `bun run synth | plan | apply`,
`bun run build` (typecheck), `bun test`.

## Defining teams

```ts
// orgs/factbird.ts
import { App, Organization, Team } from "../src/index.ts";

const app = new App();
const org = new Organization(app, "factbird", { login: "factbird" });

const engineering = new Team(org, "engineering", {
  description: "All engineers",
  privacy: "closed",
  externalGroup: { name: "GH-Engineering" }, // Entra security group (SCIM)
});

new Team(engineering, "platform", {          // nested → child of engineering
  description: "Platform & infrastructure",
  repositories: { "flight-deck": "maintain" },
});

new Team(org, "security", {                  // not IdP-synced; members managed here
  privacy: "secret",
  maintainers: ["mj"],
});

app.synth();
```

## Entra ID (SCIM) team synchronization

The goal is to link a GitHub team to an **Entra ID security group** so that team
membership is driven by the IdP. This uses GitHub's external-groups API:

- `GET /orgs/{org}/external-groups` — list Entra groups visible to the org
- `PATCH /orgs/{org}/teams/{team_slug}/external-groups` — link one group to a team

Declare the binding with `externalGroup: { name: "..." }` (or `{ id: 123 }`). The
group name is resolved to its id at apply time. Because only one group links to a
team and membership becomes IdP-owned, the `members`/`maintainers` fields are for
**non-synced** teams and are applied best-effort on team creation.

**Prerequisites (org-side, not automated here):** GitHub Enterprise Cloud with
SCIM provisioning / Enterprise Managed Users, Entra ID configured as the IdP, and
the security groups provisioned to GitHub. Until that's in place, `plan` still
shows the intended linkage and `apply` skips it unless `--enable-scim` is passed.
Wiring the Azure-side SCIM push is **future work** (see below).

> With Entra ID, only security groups are supported — no nested groups, no
> Microsoft 365 groups.
> ([GitHub docs](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups))

## Project layout

```
src/
  constructs/   App, Organization, Team, ExternalGroup — the authoring API
  synth/        manifest types + synthesizer (construct tree → desired state)
  github/       Octokit client wrapper + token resolution
  reconcile/    changes model, planner (diff), render, applier
  cli.ts        synth | plan | apply
bin/cdkgithub.ts
orgs/factbird.ts       example org definition
cicd/main.ts           CI/CD workflows (defined with @factbird/cdkactions)
.github/workflows/     generated — do not edit by hand
test/                  bun tests for synthesizer, planner, applier
```

## CI/CD

The GitHub Actions workflow is itself defined as code with
[`@factbird/cdkactions`](https://github.com/FactbirdHQ/cdkactions) in
[`cicd/main.ts`](cicd/main.ts) and synthesized to `.github/workflows/`:

```bash
bun run synth:workflows   # regenerate .github/workflows/*.yaml
```

**CI** (`cdkactions_ci.yaml`) — on PRs to `main` and pushes to `main` —
**only synthesizes the structure**: typecheck, run the unit tests, build the
desired-state manifest from the org definition, and verify the workflow YAML is
in sync with `cicd/main.ts`. It needs no secrets and never touches the live org.

The generated YAML is committed; editing it by hand is overwritten on the next
synth.

### Why no `plan`/`apply` in CI

- **`apply` is not automated.** Running it on every push would impose this repo's
  structure onto the real organization. Reconciliation towards the org is a
  deliberate act, run manually (`bun run apply`) by an operator with an org-admin
  token, not a side effect of merging.
- **The apply/plan *surface* is still tested** — `bun test` exercises the planner
  and applier against an in-memory GitHub fake (no network, no token).
- **End-to-end apply wants a sandbox.** Once a throwaway sandbox org exists, add a
  manual `workflow_dispatch` job that mints a short-lived token with
  cdkactions' `createGithubAppTokenV3` (`actions/create-github-app-token`) and
  runs `plan`/`apply` against the sandbox only.

## Out of scope for v1

- The Azure-side SCIM push that provisions groups/users into GitHub (the linkage
  endpoint is wired; enabling SCIM on the org and configuring Entra is separate).
- Team renames, org-level settings, repository creation, member invitations.
- Ongoing membership reconciliation for existing teams (IdP-owned by design).
- Multi-language publishing via jsii/projen (TypeScript only for now).

## Development

```bash
bun test           # unit tests (no network — uses an in-memory GitHub fake)
bun run build      # tsc --noEmit typecheck
```
