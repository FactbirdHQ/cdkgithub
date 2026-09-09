# cdkgithub

Define your **GitHub organization as Infrastructure-as-Code**, in the spirit of
[AWS CDK](https://aws.amazon.com/cdk/). Teams and their hierarchy, repo access,
Entra ID security group links, rulesets, the Actions policy, code security
configurations, custom properties, member privileges, and legacy branch
protection are declared in TypeScript; the tool diffs that desired state against
the live account and applies the difference. Personal accounts work too, with
the organization-only surfaces rejected rather than silently ignored.

Built on the [`constructs`](https://www.npmjs.com/package/constructs) programming
model — the same standalone library that underpins `cdk8s` and `cdktf` — with a
custom synthesizer that targets the **GitHub REST API** (via Octokit) instead of
CloudFormation.

## Why

Team structure and org policy managed by hand in the GitHub UI drift and aren't
reviewable. Here they live in git: the org is code, changes go through pull
requests, and `plan` shows exactly what will happen before anything is touched.

## How it works

```
define   examples/<org>.ts   new App / Organization / Team (+ externalGroup)
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
- **Deletes are gated** behind `--allow-delete` so unmanaged teams, rulesets,
  configurations, and properties aren't wiped by accident. Removing branch
  protection with `enabled: false` is a declaration, not a prune, so it is not
  gated. **SCIM linking is gated** behind `--enable-scim`.
- **A governance surface is unmanaged until you declare it.** See
  [Governance and policy](#governance-and-policy).

## Requirements

- [Bun](https://bun.sh) (package manager + runtime + test runner) — or use the
  [devenv](https://devenv.sh) shell, which provides it (see [Development](#development)).
- A GitHub token: `GITHUB_TOKEN`/`GH_TOKEN`, or just be logged in with
  `gh auth login` (the CLI falls back to `gh auth token`). Needs org-admin scope
  to manage teams, and `admin:org` for the governance surfaces. Code security
  configurations additionally need the org to have those features available.

## Usage

```bash
bun install

# 1. Edit your org definition
$EDITOR examples/factbird.ts

# 2. Synthesize the desired-state manifest
bun bin/cdkgithub.ts synth examples/factbird.ts     # → github.out/manifest.json

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
// examples/factbird.ts
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
  repositories: { "flow-portal": "maintain" },
});

new Team(org, "security", {                  // not IdP-synced; members managed here
  privacy: "secret",
  maintainers: ["mj"],
});

app.synth();
```

## Governance and policy

Teams say who exists. Governance says what they can do. Five more surfaces are
declared the same way, all of them scoped under the `Organization`.

A surface stays unmanaged until you declare something on it. Write no `Ruleset`
and cdkgithub never reads, reports, or prunes the org rulesets, so a definition
that only covers teams keeps working with a token that only covers teams.
Declare one ruleset and the definition owns the whole surface: live rulesets
missing from it turn into deletes, gated behind `--allow-delete` like team
deletes.

Within a resource, only the fields you write are compared. GitHub returns every
field it knows about, including the defaults it filled in, so `plan` asks whether
the live resource already says everything you asked for rather than whether the
two are identical. Adopting one setting does not reset its neighbours, and a rule
parameter you never mentioned does not show up as drift on every run.

### Organization settings

Member privileges and org-wide defaults, applied with `PATCH /orgs/{org}`.

```ts
const org = new Organization(app, "factbird", {
  login: "factbird",
  settings: {
    defaultRepositoryPermission: "read",
    membersCanCreatePublicRepositories: false,
    membersCanForkPrivateRepositories: false,
    webCommitSignoffRequired: true,
  },
});
```

The security toggles that `PATCH /orgs` still accepts
(`dependabot_alerts_enabled_for_new_repositories` and its neighbours) are not
here. GitHub has replaced them with code security configurations, which is the
surface further down.

### Rulesets

Rulesets are GitHub's replacement for branch protection, and cdkgithub models the
organization level. Org rulesets apply across repositories, and a repo-level
ruleset can only add restrictions on top of one, never loosen it. So the org
level is where a policy that has to hold everywhere belongs.

```ts
new Ruleset(org, "protect-default-branch", {
  conditions: {
    refName: { include: ["~DEFAULT_BRANCH"] },
    repositoryName: { include: ["~ALL"] },
  },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
});
```

Rules are typed, and all 21 of GitHub's rule types are covered: the
creation/update/deletion trio, `required_linear_history`, `required_signatures`,
`non_fast_forward`, `pull_request`, `required_status_checks`,
`required_deployments`, `merge_queue`, `workflows`, `code_scanning`,
`file_path_restriction`, `file_extension_restriction`, `max_file_size`,
`max_file_path_length`, and the five name and message pattern rules. Each takes
the parameters of GitHub's REST payload in camelCase, and a test round-trips one
of every type through the conversion so a schema change breaks the build rather
than an apply.

Set `enforcement: "evaluate"` to land a ruleset that records violations without
blocking anyone. That is the honest way to introduce a rule to an org that has
been running without it.

Bypass actors are named, not numbered:

```ts
bypassActors: [
  { actorType: "OrganizationAdmin" },
  { actorType: "Team", team: "platform", bypassMode: "pull_request" },
  { actorType: "Integration", app: "renovate" },
]
```

GitHub stores a numeric `actor_id` whose meaning depends on the actor type, and
those ids are not knowable when you write the definition. cdkgithub resolves the
team slug and the app slug while planning, before the diff rather than at apply
time: the live ruleset only ever carries ids, so a definition still holding a
name would report drift on every run. A name that resolves to nothing fails the
plan, which is the right moment, because nothing has been written yet. Pass a
number instead of a name to skip the lookup.

`RepositoryRole` is the exception and takes `roleId`. GitHub's REST description
carries no route for listing repository roles at the API version pinned here and
the built-in role ids are not in the published schema, so resolving a role name
would mean hardcoding a mapping nobody can check. Granting bypass to the wrong
role is not a good thing to guess at.

### Custom properties

A property classifies repositories, and a ruleset can then target the class
instead of a list of names. New repositories inherit the policy without anyone
editing the definition, which is the whole reason to bother with properties.

```ts
new CustomProperty(org, "service-tier", {
  valueType: "single_select",
  allowedValues: ["tier-1", "tier-2", "internal"],
  required: true,
  defaultValue: "internal",
  values: { "flow-portal": "tier-1" },        // per-repository values
});

new Ruleset(org, "tier-1-review", {
  conditions: {
    refName: { include: ["~DEFAULT_BRANCH"] },
    repositoryProperty: {
      include: [{ name: "service-tier", propertyValues: ["tier-1"] }],
    },
  },
  rules: [
    { type: "required_signatures" },
    {
      type: "pull_request",
      parameters: {
        requiredApprovingReviewCount: 1,
        dismissStaleReviewsOnPush: true,
        requireCodeOwnerReview: true,
        requireLastPushApproval: false,
        requiredReviewThreadResolution: true,
        allowedMergeMethods: ["squash"],
      },
    },
  ],
});
```

`plan` lists only the repositories whose value differs, and `apply` writes one
call per distinct value rather than one per repository.

### Actions policy

Three endpoints behind one construct: which repositories may run Actions, which
actions they may run, and what the `GITHUB_TOKEN` starts with.

```ts
new ActionsPolicy(org, "actions", {
  allowedActions: "selected",
  allowedActionsConfig: {
    githubOwnedAllowed: true,
    verifiedAllowed: false,
    patternsAllowed: ["factbird/*"],
  },
  defaultWorkflowPermissions: "read",
  canApprovePullRequestReviews: false,
});
```

There is one policy per organization, and a second `ActionsPolicy` fails
synthesis. With `enabledRepositories: "selected"`, name the repositories in
`selectedRepositories` and cdkgithub resolves them to ids at apply time.

### Code security configurations

One bundle of Dependabot, secret scanning, push protection, and code scanning
settings, attached to repositories.

```ts
new CodeSecurityConfiguration(org, "baseline", {
  description: "Dependabot, secret scanning, and push protection everywhere",
  dependabotAlerts: "enabled",
  secretScanning: "enabled",
  secretScanningPushProtection: "enabled",
  enforcement: "enforced",              // repo admins cannot switch it back off
  defaultForNewRepos: "all",
  attach: "all_without_configurations",
});
```

`defaultForNewRepos` is diffed against the org's current defaults. Attachment is
not. It is recorded on the repositories rather than on the configuration, so
`apply` re-issues it every run, the way it re-issues team external-group links.
GitHub's own `global` presets, "GitHub recommended" and its siblings, cannot be
edited or deleted, so cdkgithub never proposes pruning them.

## Organizations and personal accounts

A definition names one owner, and the owner decides what exists.

```ts
const org = new Organization(app, "factbird", { login: "factbird" });
// or
const me = new UserAccount(app, "martinjlowm", { login: "martinjlowm" });
```

Teams, rulesets, the Actions policy, code security configurations, custom
properties, and member privileges are all organization features. GitHub does not
offer them to a personal account, so declaring one under a `UserAccount` fails
synthesis instead of writing a manifest that could never apply:

```
UserAccount "martinjlowm" declares Team, Ruleset, which GitHub only offers to
organizations. A personal account supports repositories and their branch protection.
```

What a personal account does have is repositories and their branch protection.
See [`examples/personal.ts`](examples/personal.ts).

## Legacy branch protection

`PUT /repos/{owner}/{repo}/branches/{branch}/protection` predates rulesets and
still works. cdkgithub covers it, and warns when you use it on an organization.

```ts
const deck = new Repository(org, "flow-portal");

new BranchProtection(deck, "main", {
  enforceAdmins: true,
  requiredSignatures: true,
  requiredStatusChecks: { strict: true, checks: [{ context: "build" }] },
  requiredPullRequestReviews: {
    requiredApprovingReviewCount: 1,
    dismissStaleReviews: true,
  },
});
```

`Repository` is a scope, not something cdkgithub creates. The repository has to
exist already. Pass `repository: "name"` instead of nesting if you prefer.

### Why it warns

Two warnings, both printed to stderr by `synth` and again by `plan`, so piping a
plan to a file keeps them where a human sees them.

The first fires whenever an organization declares branch protection at all. A
ruleset covers the same rules across every repository including ones nobody has
created yet, and a repository-level rule can only add restrictions on top of one.
Protecting one branch of one repository through the old API means repeating
yourself for every branch you care about.

The second fires when a branch has legacy protection and sits inside a ruleset's
target. GitHub applies both and the stricter rule wins, so the effective policy
on that branch is not readable from either declaration alone. This one resolves
`~ALL` and `*` patterns in a ruleset's `repositoryName` condition. A ruleset that
selects by custom property is skipped rather than guessed at, because the values
that decide the match are not in the definition.

A personal account gets neither warning. It has no rulesets to prefer, so the
legacy API is simply the API.

### Retiring it

Declare `enabled: false` rather than deleting the construct:

```ts
new BranchProtection(deck, "main", { enabled: false });
```

Deleting the construct leaves the live protection in place. There is no endpoint
that lists the protected branches of an organization, so cdkgithub only ever
looks at branches the definition names and cannot prune one it was never told
about. `enabled: false` is a declaration, so unlike a team or ruleset delete it
is not gated behind `--allow-delete`.

The migration this is built for: land the ruleset on `evaluate`, read its rule
suites until it is quiet, flip it to `active`, then set `enabled: false` on the
branch protection it replaced.

## What GitHub does not expose

Worth knowing before you go looking for these.

- **Enterprise-level policy** is patchy. Some of it is REST, some GraphQL, and
  the fine-grained PAT and GitHub App installation policies are UI only. None of
  it is modelled here.
- **Fine-grained tokens do not reach the SCIM external-group endpoints.** Every
  governance surface here works with a fine-grained token (org rulesets, the
  Actions policy, and code security configurations under Administration; custom
  properties under Custom properties; teams under Members). The external-group
  linking behind `--enable-scim` is the exception: it is absent from GitHub's
  [fine-grained permissions
  index](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens),
  so that one command still wants a classic token with `admin:org`. Everything
  else runs on a fine-grained token.
- **Outside collaborator invites** have no field on `PATCH /orgs`, despite being
  a member privilege in the UI.
- **Legacy branch protection** is covered, but under protest. See
  [Legacy branch protection](#legacy-branch-protection) for the two warnings and
  the migration path off it.
- **The audit log API** reports what happened. It enforces nothing, so it has no
  place in a desired-state tool.

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
  constructs/   the authoring API: App, Organization, UserAccount, Team,
                ExternalGroup, Ruleset, ActionsPolicy,
                CodeSecurityConfiguration, CustomProperty, Repository,
                BranchProtection
  synth/        manifest.ts (teams) + governance.ts (org policy) +
                branch-protection.ts + warnings.ts + synthesizer
  github/       Octokit client wrapper, key casing, token resolution
  reconcile/    changes model, live-state reader, planner and applier (teams in
                planner.ts/applier.ts, policy in plan-governance.ts/
                apply-governance.ts), subset comparison, render
  cli.ts        synth | plan | apply
bin/cdkgithub.ts
examples/factbird.ts   example org definition
examples/personal.ts   example personal-account definition
scripts/import-org.ts  dump a live org's teams into a stack definition
cicd/main.ts           CI/CD workflows (defined with @factbird/cdkactions)
.github/workflows/     generated — do not edit by hand
test/                  bun tests for synthesizer, planner, applier, governance
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
- Team renames, repository creation, member invitations.
- Ongoing membership reconciliation for existing teams (IdP-owned by design).
- Repository-level rulesets, runner groups, and org or repo secrets and
  variables. All three have REST endpoints and would fit the same model.
- Repository creation. `Repository` is a scope for attaching things to a
  repository that already exists.
- Importing governance. `scripts/import-org.ts` reads teams only, so an org that
  already has rulesets needs them written by hand once.
- Multi-language publishing via jsii/projen (TypeScript only for now).

## Development

A [devenv](https://devenv.sh) shell pins the toolchain (Bun + `gh`) so everyone
and CI use the same versions:

```bash
devenv shell       # or `direnv allow` to enter it automatically
                   # `bun install` runs on entry
devenv test        # typecheck + unit tests (same gate as CI)
```

Without devenv, install Bun yourself and run the scripts directly:

```bash
bun test           # unit tests (no network — uses an in-memory GitHub fake)
bun run build      # tsc --noEmit typecheck
```
