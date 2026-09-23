# Reference

## Commands

| Command | Effect |
| --- | --- |
| `synth <config.ts>` | Run the definition, write `github.out/manifest.json`, stamp provenance. |
| `diff` | Read the live organization whole and print it as a tree against the manifest. Read-only. |
| `plan` | Diff the manifest against the surfaces it declares and print the change list. Read-only. |
| `apply` | Print the plan, then reconcile the organization to match. Dry run without `--yes`. |
| `import <org>` | Read the live organization and emit a definition file. Read-only. |
| `scim` | Configure Entra ID SCIM provisioning to match the manifest's declaration. Dry run without `--yes`. |

`plan` and `apply` validate the manifest on read and print its provenance
line. A misspelled flag or a stray argument is an error, never silently
ignored.

## Options

| Option | Commands | Effect |
| --- | --- | --- |
| `--manifest <path>` | diff, plan, apply | Manifest to read. Default `github.out/manifest.json`. |
| `--output <path>` | import | Where the definition is written. Default: stdout. |
| `--repositories[=names]` | import | Walk repositories and import their rulesets, variables, and secrets too. Bare, every repository; with names, only those. One round of requests per repository. |
| `--yes` | apply, scim | Execute changes. Without it, the command prints the plan and stops. |
| `--allow-delete` | apply | Permit every destructive change kind. |
| `--allow-delete=<scopes>` | apply | Permit only the named kinds. See the scope table. |
| `--require-approval <level>` | apply | When to pause for an interactive "y": `never`, `destructive` (default), or `any-change`. Without a terminal, a required approval refuses instead of assuming. |
| `--force` | apply | Skip the guard that refuses to delete three or more teams amounting to half the organization's teams or more in one run. |
| `--enable-scim` | apply | Perform Entra ID external-group linking. Otherwise link changes are skipped and reported. |
| `--changed-only` | diff | Hide every subtree that matches end to end. Also filters `--by-person`. |
| `--full` | diff | Expand every team and list every grant, rather than the first eight. |
| `--live` | diff | Print the live organization and stop. No manifest is compared. |
| `--by-person` | diff | Pivot onto people: who can reach what, before and after. |
| `--csv` | diff | Write `--by-person` as CSV, one row per person per repository. |
| `--color` / `--no-color` | diff | Force color on or off. The default colors a terminal and leaves a pipe plain; `NO_COLOR` and `FORCE_COLOR` are honoured, and the flags beat both. |

## Delete scopes

Each scope names one destructive change kind for `--allow-delete=<scopes>`:

| Scope | Permits removing |
| --- | --- |
| `teams` | A team absent from the definition. |
| `members` | A team member the declared roster does not carry. |
| `grants` | A repository grant the declared access map does not carry. |
| `org-roles` | An organization role assignment. |
| `repo-roles` | A custom repository role. |
| `rulesets` | An organization ruleset. |
| `repo-rulesets` | A repository ruleset, on a repository the definition declares one on. |
| `runner-groups` | A runner group. GitHub's default group is never a candidate. |
| `variables` | An Actions variable, from a declared scope. |
| `secrets` | An Actions secret, from a declared scope. |
| `security-configs` | A code security configuration. |
| `properties` | A custom property. |
| `branch-protection` | A branch's legacy protection, from `enabled: false`. |

## Backups

Before its first write, `apply --yes` saves four files under
`github.out/backups/<timestamp>/`:

| File | Contents |
| --- | --- |
| `live-state.json` | The organization as this run read it, before anything was touched. |
| `rollback-manifest.json` | A manifest restoring the team structure to that state. Applying it reverts. |
| `plan.json` | The change list that was approved. |
| `journal.jsonl` | One line per attempted change, appended as the run goes: kind, description, and applied, skipped, or failed. |

## Manifest provenance

`synth` stamps the manifest with a `provenance` object: `source` (the
definition file), `commit` (`git rev-parse HEAD` at synth time), `dirty`
(whether the working tree had uncommitted changes), and `synthesizedAt`.
`plan` and `apply` print the line, so a review can tell a freshly
synthesized manifest from a stale one.

## Authentication

The CLI takes a token from `GITHUB_TOKEN` or `GH_TOKEN`, and otherwise runs
`gh auth token`, bounded at ten seconds. Managing teams needs org-admin
scope; the governance surfaces need `admin:org`; code security configurations
additionally need the organization to have those features.

Every surface works with a fine-grained token (rulesets, the Actions policy,
and code security configurations under organization Administration; custom
properties under Custom properties; teams under Members; runner groups under
Self-hosted runners; organization secrets and variables under the
organization Secrets and Variables permissions, and their repository-scoped
counterparts, with repository rulesets, under the matching repository
permissions) except one: the SCIM external-group endpoints behind
`--enable-scim` are absent from GitHub's
[fine-grained permissions index](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and still want a classic token with `admin:org`.

`scim` talks to Microsoft Graph rather than GitHub. It takes a Graph token
from `AZURE_GRAPH_TOKEN` and otherwise runs
`az account get-access-token --resource https://graph.microsoft.com`, bounded
at ten seconds. The signed-in identity must be allowed to manage enterprise
applications and their provisioning and to read groups; Entra's Cloud
Application Administrator role covers it. The GitHub token Entra provisions
with is read from the environment variable the definition's `tokenFrom`
names, and no token of either kind is ever written to disk.

## Rate limits

The client queues requests under GitHub's own throttling rules and waits out
a primary or secondary rate limit, retrying a few times before giving up. A
large organization plans slowly rather than failing halfway through an apply.

## Ownership semantics

A surface is unmanaged until the definition declares it, and owned from then
on:

- A team with no `repositories` map keeps its grants unread and untouched;
  declaring the map, `{}` included, owns it.
- Declaring `members` or `maintainers` owns the whole roster; a team with an
  `externalGroup` never has its roster diffed.
- Write no `Ruleset` and the org's rulesets are never read, reported, or
  pruned. Declare one and the definition owns the surface: live rulesets
  missing from it become deletes, gated like everything else.
- The repository-scoped collections (repository rulesets, and Actions
  secrets and variables) own one scope at a time. An organization-scoped
  secret owns the organization's secrets; an entry naming `flight-deck` owns
  `flight-deck`'s; a repository nothing names is never read or pruned.

Within a resource, only the fields you write are compared. GitHub returns
every field it knows, defaults included, so `plan` asks whether the live
resource already says everything you asked for rather than whether the two
are identical. Adopting one setting does not reset its neighbours.

## Constructs

The authoring API, all exported from `src/index.ts`.

### Organization and UserAccount

A definition names one owner, and the owner decides what exists.

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

`settings` is member privileges and org-wide defaults, applied with
`PATCH /orgs/{org}`. The security toggles that endpoint still accepts
(`dependabot_alerts_enabled_for_new_repositories` and its neighbours) are not
modelled; GitHub has replaced them with code security configurations.

`UserAccount` is the personal-account owner. It supports repositories and
their branch protection; declaring any organization-only construct under it
fails synthesis with the constructs named. See
[`examples/personal.ts`](../examples/personal.ts).

### Team

```ts
new Team(engineering, "platform", {
  name: "Platform",                       // defaults to the construct id
  previousSlug: "infra",                  // rename marker, see the guide
  description: "Platform & infrastructure",
  privacy: "closed",                      // default; "secret" hides the team
  maintainers: ["casey"],
  members: ["ada"],
  repositories: [maintain("flight-deck")], // or { "flight-deck": "maintain" }
  externalGroup: { name: "GH-Platform" }, // Entra ID binding, or { id: 123 }
});
```

Nesting is the construct tree: a `Team` scoped under another `Team` becomes a
child team, and a team under the `Organization` is top-level. Parent teams
require `closed` privacy.

### Grant helpers

`pull`, `triage`, `push`, `maintain`, and `admin` each take any number of
repository names and return grants; `role(name)` returns the same shape of
helper for a custom repository role. Lists flatten, so
`[push('nest'), triage(...systemII)]` is one list of grants. Synthesis
rejects a repository granted twice in one team, naming both grants.

`maintain` and `admin` also claim the repository. One team holds that claim
per repository, checked at synthesis:

```
Repository "nest" is owned by both "cloud" ("maintain") and "product"
("admin"). Both permissions say a team answers for a repository, and one
does; grant the other team a lesser permission instead.
```

GitHub answers with `read`/`write` where it takes `pull`/`push`; cdkgithub
maps the reply onto the request, so a grant written as `push` matches a live
`write` instead of reporting drift forever.

### Repository and BranchProtection

```ts
const deck = new Repository(org, "flight-deck");

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

A declared repository the organization does not have is created; an existing
one is adopted as it stands, and there is no update and no delete beside that
create. Unset visibility resolves to `internal` under an enterprise account
and to `private` otherwise; `public` is never inferred. `BranchProtection`
takes `repository: "name"` instead of nesting if you prefer, and
`enabled: false` declares the branch unprotected.

### Ruleset

```ts
new Ruleset(org, "protect-default-branch", {
  conditions: {
    refName: { include: ["~DEFAULT_BRANCH"] },
    repositoryName: { include: ["~ALL"] },
  },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  bypassActors: [
    { actorType: "OrganizationAdmin" },
    { actorType: "Team", team: "platform", bypassMode: "pull_request" },
    { actorType: "Integration", app: "renovate" },
  ],
});
```

Rules are typed and all 21 of GitHub's rule types are covered: the
creation/update/deletion trio, `required_linear_history`,
`required_signatures`, `non_fast_forward`, `pull_request`,
`required_status_checks`, `required_deployments`, `merge_queue`, `workflows`,
`code_scanning`, `file_path_restriction`, `file_extension_restriction`,
`max_file_size`, `max_file_path_length`, and the five name and message
pattern rules. Each takes the parameters of GitHub's REST payload in
camelCase, and a test round-trips one of every type through the conversion so
a schema change breaks the build rather than an apply.

`enforcement: "evaluate"` records violations without blocking anyone.

Bypass actors are named, and cdkgithub resolves the team slug or app slug to
GitHub's numeric `actor_id` while planning; a name that resolves to nothing
fails the plan before anything is written. Pass a number to skip the lookup.
`RepositoryRole` is the exception and takes `roleId`: the API version pinned
here has no route for listing repository roles, and guessing at a bypass
grant is the wrong place to guess.

### RepositoryRuleset

```ts
const deck = new Repository(org, "flight-deck");

new RepositoryRuleset(deck, "merge-queue", {
  conditions: { refName: { include: ["~DEFAULT_BRANCH"] } },
  rules: [
    {
      type: "merge_queue",
      parameters: {
        mergeMethod: "SQUASH",
        groupingStrategy: "ALLGREEN",
        minEntriesToMerge: 1,
        maxEntriesToMerge: 5,
        maxEntriesToBuild: 5,
        minEntriesToMergeWaitMinutes: 5,
        checkResponseTimeoutMinutes: 60,
      },
    },
  ],
});
```

The same rule union and bypass actors as `Ruleset`, on one repository. The
differences follow from the scope: `refName` is the only condition, the
`repository` lifecycle target does not exist here, and org and enterprise
rulesets visible from the repository are never read as its own, so they are
never proposed for pruning. Nest it under a `Repository` or pass
`repository`. An organization ruleset is the stronger tool where either
would do; this one is for the rule that belongs to a single repository, such
as a merge queue or a release-tag pattern, and for personal accounts, which
have no organization to inherit from.

### CustomProperty

```ts
new CustomProperty(org, "service-tier", {
  valueType: "single_select",
  allowedValues: ["tier-1", "tier-2", "internal"],
  required: true,
  defaultValue: "internal",
  values: { "flight-deck": "tier-1" },   // per-repository values
});
```

A ruleset can then target the class through its `repositoryProperty`
condition instead of a list of names, and new repositories inherit the policy
without anyone editing the definition. `plan` lists only the repositories
whose value differs, and `apply` writes one call per distinct value.

### ActionsPolicy

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

Three endpoints behind one construct: which repositories may run Actions,
which actions they may run, and what the `GITHUB_TOKEN` starts with. One
policy per organization; a second fails synthesis. With
`enabledRepositories: "selected"`, name the repositories in
`selectedRepositories` and they resolve to ids at apply time.

### RunnerGroup

```ts
new RunnerGroup(org, "deploy-runners", {
  visibility: "selected",
  selectedRepositories: ["flight-deck"],
  restrictedToWorkflows: true,
  selectedWorkflows: ["factbird/flight-deck/.github/workflows/deploy.yaml@main"],
});
```

The access boundary around a pool of self-hosted runners: which repositories
may send jobs to it, and optionally which workflows. Registering the machines
themselves happens wherever the machines live. `visibility` defaults to
`all`; `allowsPublicRepositories` defaults off and should stay off for any
runner holding credentials, because a fork's pull request runs the fork's
code. GitHub's built-in default group can be declared by name and managed,
and is never proposed for deletion, because GitHub refuses one.

### ActionsVariable and ActionsSecret

```ts
new ActionsVariable(org, "DEPLOY_REGION", {
  value: "eu-west-1",
  visibility: "private",
});
new ActionsSecret(org, "NPM_TOKEN", { visibility: "private" });

const deck = new Repository(org, "flight-deck");
new ActionsVariable(deck, "SENTRY_PROJECT", { value: "deck" });
new ActionsSecret(deck, "SENTRY_DSN", { valueFrom: "DECK_SENTRY_DSN" });
```

One construct each for both scopes: nested under a `Repository` (or passing
`repository`) the entry lives on that repository, otherwise on the
organization. An organization entry must declare `visibility` (`all`,
`private`, or `selected` with `selectedRepositories`), and a repository
entry must not, because only its own repository reads it. Names compare
case-insensitively, the way GitHub stores them.

A variable carries its value in the clear and diffs on it. A secret carries
no value anywhere: `valueFrom` names the environment variable `apply` reads
at the moment of writing, and the plan diffs existence and visibility, the
whole of what GitHub can report back. See
[Declare Actions secrets without their values](how-to.md#declare-actions-secrets-without-their-values).

### CodeSecurityConfiguration

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

`defaultForNewRepos` is diffed against the org's current defaults. Attachment
is recorded on the repositories rather than the configuration, so `apply`
re-issues it every run, the way it re-issues external-group links. GitHub's
own `global` presets cannot be edited or deleted, so they are never proposed
for pruning.

### CustomRepositoryRole

```ts
new CustomRepositoryRole(org, "Merge Queue Jumper", {
  description: "Bypass the merge queue",
  baseRole: "push",
  permissions: ["bypass_branch_protection"],
});
```

A custom role ranks as the built-in it extends, which is how grants through
it compare against inherited access.

### OrganizationRole

```ts
new OrganizationRole(org, 'security_manager', { teams: ['devops'] });
```

The predefined roles carry weight worth knowing:

| Role | Grants |
| --- | --- |
| `all_repo_read` through `all_repo_admin` | That permission on every repository. |
| `security_manager` | `read` on every repository, plus 22 security permissions. |
| `open_source_license_manager` | `read` on every repository, plus licence review. |

Whenever the definition declares any organization role, `plan` reads every
role and prints the assignments nothing accounts for:

```
Organization roles held outside this definition:
  all_repo_admin (admin on every repository): some-user
  ci_cd_admin: another-user, a-third
```

### ScimProvisioning

```ts
new ScimProvisioning(org, "entra", {
  tenantId: "contoso.onmicrosoft.com",   // or the tenant GUID
  applicationDisplayName: "GitHub SCIM (factbird)",  // the default
  tokenFrom: "GITHUB_SCIM_TOKEN",                    // the default
  groups: ["GH-Everyone"],   // default: every team's externalGroup name
});
```

The Entra ID enterprise application that pushes security groups and their
members into GitHub, reconciled by `cdkgithub scim` rather than by `apply`,
because it writes to a different provider under different credentials. At
most one per organization. The application is found by
`applicationDisplayName` and created from GitHub's gallery template
(`GitHub Enterprise Cloud - Organization`) when missing, so the name is what
makes reruns idempotent. Renaming it makes the next run create a second
application rather than adopt the first.

The setup is ensure-only: it assigns groups and never unassigns them, and it
deletes nothing. `tokenFrom` names the environment variable holding the
GitHub token Entra presents when provisioning; the manifest carries the name
and never a value. See
[Provision Entra ID groups into GitHub](how-to.md#provision-entra-id-groups-into-github-scim).

## The diff tree

```
  organization factbird
~   team engineering
      + repo build-tools = "push"
      + member alex-doe
~     team cloud
        - member alex-doe
~       team analytics-platform   (was app-1)
          name: "App 1" -> "Analytics Platform"
+     team ml-experiments   (9 repos, 8 people)
-     team legacy-tools   (8 repos, 8 people)

28 teams to change, 2 to add, 1 to remove.
```

Indentation says where a team sits; the gutter says what happens to it: `+`
adds, `-` removes, `~` changes. A team that matches is one line, a team that
differs expands into what differs, and a team being added or removed is
summarised. A declaration carrying `previousSlug` pairs with the live team of
that name, so a rename reads as one changed team. Color repeats the marks:
green adds, red removes, yellow changes, dim grey for what matches.

What the comparison is made of:

- **Repository access, effective rather than declared.** A child team holds
  whatever its ancestors grant, and GitHub reports that inherited access on
  the child as though the child held it, so both sides resolve inheritance
  before comparing. A child re-declaring its parent's grant is no difference,
  and the report under the tree names those redundant grants, since deleting
  one changes nothing.
- **Rosters, direct rather than reported.** GitHub reports a descendant's
  members on every team above it; the live read subtracts them, so each
  roster is the people a team holds in its own right. Maintainer roles are
  not inherited and are taken as they come. An Entra-bound team has no roster
  compared at all.
- **Everything else about a team**: name, description, privacy, and its place
  in the hierarchy.

`--by-person` reads the same two trees down the other axis: each person and
the repositories they can reach, before and after, with the team granting
each one named. Access is the union of the effective access of every team a
person belongs to directly; where two teams grant the same repository, the
stronger permission wins, which is what GitHub does.

```
alex-doe   (36 -> 4 repos)
    + team engineering
    - team cloud
    + build-tools = "push"   via engineering
    - infra-modules   (had "push" via cloud)
    … and 21 more   (--full to list)
```

Beneath the tree, `diff` names any repository the organization has that no
team reaches and the definition does not declare. Declare it or archive it.

## Warnings

`synth` and `plan` print two warnings to stderr, so piping a plan to a file
keeps them where a human sees them:

- An organization declaring legacy branch protection at all. Rulesets cover
  the same rules across every repository, including ones nobody has created
  yet.
- A branch holding legacy protection while sitting inside a ruleset's target.
  GitHub applies both and the stricter rule wins, so neither declaration
  alone reads as the effective policy. Ruleset `repositoryName` patterns
  (`~ALL`, `*`) are resolved; a ruleset selecting by custom property is
  skipped rather than guessed at.

A personal account gets neither warning: it has no rulesets to prefer.

## What GitHub does not expose

- **Enterprise-level policy** is patchy: some REST, some GraphQL, and the
  fine-grained PAT and GitHub App installation policies are UI only. None of
  it is modelled here.
- **Enabling SCIM on an organization** is a UI step, as is minting the token
  Entra provisions with. `cdkgithub scim` configures everything on the Entra
  side and assumes both.
- **Outside collaborator invites** have no field on `PATCH /orgs`, despite
  being a member privilege in the UI.
- **No endpoint lists an organization's protected branches**, which is why
  legacy protection is only ever read for branches the definition names, and
  never pruned.
- **The audit log API** reports what happened. It enforces nothing, so it has
  no place in a desired-state tool.

## Project layout

```
src/
  constructs/   the authoring API: App, Organization, UserAccount, Team,
                OrganizationRole, CustomRepositoryRole, Ruleset,
                RepositoryRuleset, ActionsPolicy, RunnerGroup, ActionsVariable,
                ActionsSecret, ScimProvisioning, CodeSecurityConfiguration,
                CustomProperty, Repository, BranchProtection, and the grant
                helpers
  synth/        synthesizer + manifest types (teams in manifest.ts, org policy
                in governance.ts, actions-admin.ts, branch-protection.ts),
                manifest validation, warnings
  github/       Octokit client wrapper (throttled and retrying), key casing,
                token resolution, secret sealing
  entra/        the `scim` command's Microsoft Graph client, token resolution,
                and the provisioning setup it reconciles
  import/       the `import` command: live org -> definition file
  reconcile/    the change model, live-state reader, planner and applier
                (teams in planner.ts/applier.ts, policy in plan-governance.ts/
                apply-governance.ts), backups and the rollback manifest,
                subset comparison, plan rendering; tree.ts + tree-diff.ts +
                render-tree.ts build and compare the org as a tree for `diff`,
                access-by-person.ts + render-person.ts pivot it onto people,
                plan-org-roles.ts diffs who holds each organization role,
                plan-repo-rulesets.ts + plan-actions-admin.ts diff the
                repository rulesets, runner groups, secrets, and variables
  cli.ts        synth | diff | plan | apply | import | scim
bin/cdkgithub.ts
docs/                  how-to guides, this reference, and the design notes
examples/factbird.ts   example org definition
examples/personal.ts   example personal-account definition
cicd/main.ts           CI workflow, defined with @factbird/cdkactions
.github/workflows/     generated, do not edit by hand
test/                  bun tests against an in-memory GitHub fake
```

## CI and development

CI (`cdkactions_ci.yaml`, generated from `cicd/main.ts`) runs on pull
requests to `main` and pushes to `main`: typecheck, unit tests, a synth of
the example definition, and a check that the workflow YAML matches
`cicd/main.ts`. It needs no secrets and never touches the live organization.

```bash
bun run synth:workflows   # regenerate .github/workflows/*.yaml
bun test                  # unit tests, no network, in-memory GitHub fake
bun run build             # tsc --noEmit typecheck
devenv shell              # pinned toolchain (Bun + gh); bun install on entry
devenv test               # typecheck + unit tests, the same gate as CI
```
