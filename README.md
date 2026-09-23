# cdkgithub

**Declare your GitHub organization in TypeScript. Review it in a pull request.
Apply it with a plan you have read.**

Teams and their hierarchy, repository access, Entra ID group links, rulesets,
the Actions policy, code security configurations, custom properties, member
privileges, and branch protection live in one definition in git. cdkgithub
diffs that definition against the live organization and applies the
difference over the GitHub REST API. It is built on
[`constructs`](https://www.npmjs.com/package/constructs), the library under
the AWS CDK, cdk8s, and cdktf, and it keeps the CDK's interface: `synth`,
`diff`, an assembly directory, `--require-approval`.

```ts
const org = new Organization(app, "factbird", { login: "factbird" });

const engineering = new Team(org, "engineering", {
  externalGroup: { name: "GH-Engineering" },   // roster driven by Entra ID
});

new Team(engineering, "platform", {            // nested, so a child team
  repositories: [maintain("flight-deck")],
});
```

```
Plan for organization "factbird":

  + team platform (under engineering)
  ~ team cloud on nest: "push" -> "maintain"
  - team legacy-tools   (requires --allow-delete)
```

Safety is the product:

- `apply` is a dry run until `--yes`, and even then it pauses for an
  interactive "y" while the plan holds destructive changes.
- Nothing is deleted without `--allow-delete`, and the flag scopes down to
  the kinds you name, so pruning a team does not also authorize revoking an
  organization role.
- Every apply that writes saves a backup first, including a rollback manifest
  that an ordinary apply restores.
- Repositories are never deleted. No code path exists for it, and a test
  fails the build if one appears.

New to the tool? Start with [Getting started](#getting-started). Mid-task?
[How-to guides](#how-to-guides). Looking up a flag or a field?
[Reference](#reference). Wondering why it behaves the way it does?
[Design notes](#design-notes).

## Getting started

This walkthrough goes from a fresh checkout to a first applied change: two
teams, one nested under the other, on an organization you administer. Nothing
before the last step writes to GitHub.

Install [Bun](https://bun.sh) and the [GitHub CLI](https://cli.github.com)
first. With [devenv](https://devenv.sh), `devenv shell` provides both.

1. Install dependencies and authenticate:

   ```bash
   bun install
   gh auth login
   ```

2. Create `examples/my-org.ts`, replacing both `my-org`s with your
   organization's login:

   ```ts
   import { App, Organization, Team } from "../src/index.ts";

   const app = new App();
   const org = new Organization(app, "my-org", { login: "my-org" });

   const engineering = new Team(org, "engineering", {
     description: "All engineers",
   });

   new Team(engineering, "platform", {
     description: "Platform and infrastructure",
   });

   app.synth();
   ```

3. Synthesize the desired-state manifest:

   ```bash
   bun bin/cdkgithub.ts synth examples/my-org.ts
   ```

   This writes `github.out/manifest.json` and prints nothing when the
   definition is clean.

4. Compare the definition against the live organization, read-only:

   ```bash
   bun bin/cdkgithub.ts diff
   ```

   The output is your organization as a tree. The two new teams appear with a
   `+` in the gutter; teams the definition does not mention are listed
   unmarked.

5. Preview the exact changes an apply would make, still read-only:

   ```bash
   bun bin/cdkgithub.ts plan
   ```

   Expect two lines, `+ team engineering` and
   `+ team platform (under engineering)`, and a summary saying two creates.

6. Apply:

   ```bash
   bun bin/cdkgithub.ts apply --yes
   ```

   The plan prints again, a backup directory is announced, and the two teams
   are created. Creating is not destructive, so there is no prompt. Run
   `bun bin/cdkgithub.ts plan` once more and it reports that the organization
   matches the desired state.

7. Commit `examples/my-org.ts`. The definition is now the reviewable record
   of your team structure, and every later change starts as an edit to it.

## How-to guides

### Rename a team

GitHub derives a team's slug from its name and addresses the team by that
slug, and cdkgithub keys identity on the slug too, so a bare rename reads as
one team deleted and another created. Name the old slug to make it a rename:

```ts
new Team(cloud, 'tech-council', {
  name: 'Tech Council',
  previousSlug: 'tech-leads',
});
```

The team keeps its id, members, grants, and history, because the operation is
the `PATCH` GitHub offers for exactly this. The plan shows the slug and the
name moving, and nothing is deleted.

`previousSlug` is looked up only when nothing matches the derived slug, so
the line goes inert the moment the rename lands and can be deleted whenever
you next touch the team. Leaving it is harmless: it will not grab a team
someone later creates under the freed-up name.

Before renaming, grep for the old slug outside the definition. `CODEOWNERS`
is the file that bites, since `@org/old-slug` silently stops matching anyone.

### Own a team's roster and repository access

A team owns nothing it does not declare. To put a roster or the repository
grants under the definition's control, declare them:

```ts
new Team(org, "cloud", {
  members: ["ada"],                       // owns the roster
  repositories: { nest: "push" },         // owns the access
});

new Team(org, "security", {
  externalGroup: { name: "GH-Security" }, // roster owned by Entra
  repositories: {},                       // owns the access, and grants none
});
```

Declaring either roster list owns the whole roster, so the list you leave off
reads as empty rather than as unmanaged. Declaring `repositories` owns the
access map, `{}` included: a live grant missing from it becomes a removal,
gated behind `--allow-delete`. A team with an `externalGroup` is the
exception: Entra drives its membership, so its roster is never diffed
whatever it declares.

The map form takes a permission per repository. The list form reads
permission-first and spreads groups:

```ts
repositories: [maintain("nest", "nest-qa"), triage(...systemII)],
```

### Grant access through a custom repository role

A permission is one of the five built-ins or the display name of a custom
repository role the organization defines. Bind the role name once and grant
through the binding, so a typo fails the compiler instead of reaching `plan`:

```ts
// roles.ts, beside the CustomRepositoryRole that declares it
export const mergeQueueJumper = role('Merge Queue Jumper');

// wherever it is granted
repositories: [mergeQueueJumper('nest'), push('fbctl')],
```

`plan` resolves every non-built-in name against the organization's custom
repository roles and fails on one that matches nothing, before anything is
written.

### Assign organization roles

Declare who holds a role; the role itself is GitHub's:

```ts
new OrganizationRole(org, 'security_manager', {
  teams: ['devops'],
  users: ['a-security-engineer'],
});
```

`teams` and `users` are separate surfaces on the same role. Declaring one and
leaving the other off owns the first and leaves the second alone. An empty
list declares that nobody should hold the role, and revoking is gated behind
`--allow-delete`. A role name GitHub does not define fails the plan.

### Link a team to an Entra ID security group

Prerequisites, none of them automated here: GitHub Enterprise Cloud with SCIM
provisioning or Enterprise Managed Users, Entra ID configured as the IdP, and
the security group provisioned to GitHub. With Entra ID only security groups
link, no nested groups and no Microsoft 365 groups
([GitHub docs](https://docs.github.com/en/enterprise-cloud@latest/admin/managing-iam/provisioning-user-accounts-with-scim/managing-team-memberships-with-identity-provider-groups)).

Declare the binding on the team:

```ts
new Team(org, "security", {
  externalGroup: { name: "GH-Security" },  // or { id: 123 } to skip the lookup
});
```

Then apply with the SCIM gate open:

```bash
bun bin/cdkgithub.ts apply --yes --enable-scim
```

Without `--enable-scim`, the link is planned, skipped, and reported, so the
rest of the definition still applies. The group name resolves to its id at
apply time; a group that is not provisioned yet fails with its name in the
error. This one surface needs a classic token with `admin:org`, because
GitHub's fine-grained permissions do not cover the external-groups endpoints.

### Adopt an organization built by hand

Bootstrap a definition from the live organization instead of writing it from
scratch:

```bash
bun scripts/import-org.ts <org> > examples/<org>.ts
```

The importer reads teams, hierarchy, per-team grants, and rosters. It does
not read governance, so rulesets, properties, and policies are written by
hand once. Then iterate: `synth`, `diff`, and trim until the diff is quiet.

### Lock names down at compile time

Repository names, usernames, and role names belong to your organization, so
the types ship open and a misspelling survives until `plan` checks it. A
definition that knows its names can close them:

```ts
export const USERS = ['ana', 'bo'] as const;
export const REPOSITORIES = ['nest', 'fbctl'] as const;

declare module 'cdkgithub/src/index.ts' {
  interface Vocabulary {
    member: (typeof USERS)[number];
    repository: (typeof REPOSITORIES)[number];
  }
}
```

From then on every roster and grant is checked against those lists:
`members: ['anna']` and `push('nset')` stop compiling. A project that
declares nothing keeps the open types and loses nothing. The declaration is
global to a compilation unit; where that matters, `teamOf<Username>()` binds
a vocabulary locally and returns the same constructor with a narrower
parameter type.

### Run an access review

Pivot the diff onto people rather than teams:

```bash
bun bin/cdkgithub.ts diff --by-person                 # who reaches what, before and after
bun bin/cdkgithub.ts diff --by-person --changed-only  # only people something happens to
bun bin/cdkgithub.ts diff --csv > access.csv          # one row per person per repository
```

Two access paths sit outside the team structure and need checking by hand:
organization owners reach every repository whatever the teams say, and a
collaborator added to a single repository holds a grant no team records.
`plan` prints a third: organization role assignments the definition does not
account for, which reach further than any team grant. The plain `diff` also
lists repositories no team reaches and the definition does not declare, each
one a repository with no maintainer written down anywhere.

### Migrate legacy branch protection to a ruleset

1. Write the ruleset with `enforcement: "evaluate"`, so it records violations
   without blocking anyone.
2. Apply, and read the ruleset's rule suites in GitHub until they are quiet.
3. Flip it to `enforcement: "active"` and apply again.
4. Retire the old protection by declaring it off, not by deleting the
   construct:

   ```ts
   new BranchProtection(deck, "main", { enabled: false });
   ```

   Deleting the construct leaves the live protection in place, because no
   endpoint lists an organization's protected branches and cdkgithub cannot
   prune what it was never told about.

5. Apply with the gate open for exactly this kind of removal:

   ```bash
   bun bin/cdkgithub.ts apply --yes --allow-delete=branch-protection
   ```

### Revert an apply

Every apply that writes first saves `github.out/backups/<timestamp>/`. To put
the team structure back the way that run found it:

```bash
bun bin/cdkgithub.ts apply \
  --manifest github.out/backups/<timestamp>/rollback-manifest.json --yes
```

The rollback manifest covers teams, hierarchy, and every roster and grant the
run had read. Governance surfaces revert the declarative way instead: revert
the definition commit, `synth`, `apply`. For a run that stopped partway,
`journal.jsonl` in the same directory says exactly what landed and what never
ran; re-running `apply` continues from live state.

### Run apply from automation

The interactive prompt refuses when there is no terminal to ask on, so
automation states its approval up front:

```bash
bun bin/cdkgithub.ts apply --yes --require-approval never
```

Have the pipeline run `plan` on the pull request and gate the apply on that
review. Scope deletions to what the automation is allowed to prune, for
example `--allow-delete=grants,members`, and leave `--force` out: a refused
mass deletion in automation is a stale manifest to investigate, not a prompt
to override.

## Reference

### Commands

| Command | Effect |
| --- | --- |
| `synth <config.ts>` | Run the definition, write `github.out/manifest.json`, stamp provenance. |
| `diff` | Read the live organization whole and print it as a tree against the manifest. Read-only. |
| `plan` | Diff the manifest against the surfaces it declares and print the change list. Read-only. |
| `apply` | Print the plan, then reconcile the organization to match. Dry run without `--yes`. |

`plan` and `apply` validate the manifest on read and print its provenance
line. A misspelled flag or a stray argument is an error, never silently
ignored.

### Options

| Option | Commands | Effect |
| --- | --- | --- |
| `--manifest <path>` | diff, plan, apply | Manifest to read. Default `github.out/manifest.json`. |
| `--yes` | apply | Execute changes. Without it, apply prints the plan and stops. |
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

### Delete scopes

Each scope names one destructive change kind for `--allow-delete=<scopes>`:

| Scope | Permits removing |
| --- | --- |
| `teams` | A team absent from the definition. |
| `members` | A team member the declared roster does not carry. |
| `grants` | A repository grant the declared access map does not carry. |
| `org-roles` | An organization role assignment. |
| `repo-roles` | A custom repository role. |
| `rulesets` | An organization ruleset. |
| `security-configs` | A code security configuration. |
| `properties` | A custom property. |
| `branch-protection` | A branch's legacy protection, from `enabled: false`. |

### Backups

Before its first write, `apply --yes` saves four files under
`github.out/backups/<timestamp>/`:

| File | Contents |
| --- | --- |
| `live-state.json` | The organization as this run read it, before anything was touched. |
| `rollback-manifest.json` | A manifest restoring the team structure to that state. Applying it reverts. |
| `plan.json` | The change list that was approved. |
| `journal.jsonl` | One line per attempted change, appended as the run goes: kind, description, and applied, skipped, or failed. |

### Manifest provenance

`synth` stamps the manifest with a `provenance` object: `source` (the
definition file), `commit` (`git rev-parse HEAD` at synth time), `dirty`
(whether the working tree had uncommitted changes), and `synthesizedAt`.
`plan` and `apply` print the line, so a review can tell a freshly
synthesized manifest from a stale one.

### Authentication

The CLI takes a token from `GITHUB_TOKEN` or `GH_TOKEN`, and otherwise runs
`gh auth token`, bounded at ten seconds. Managing teams needs org-admin
scope; the governance surfaces need `admin:org`; code security configurations
additionally need the organization to have those features.

Every surface works with a fine-grained token (rulesets, the Actions policy,
and code security configurations under Administration; custom properties
under Custom properties; teams under Members) except one: the SCIM
external-group endpoints behind `--enable-scim` are absent from GitHub's
[fine-grained permissions index](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
and still want a classic token with `admin:org`.

### Rate limits

The client queues requests under GitHub's own throttling rules and waits out
a primary or secondary rate limit, retrying a few times before giving up. A
large organization plans slowly rather than failing halfway through an apply.

### Ownership semantics

A surface is unmanaged until the definition declares it, and owned from then
on:

- A team with no `repositories` map keeps its grants unread and untouched;
  declaring the map, `{}` included, owns it.
- Declaring `members` or `maintainers` owns the whole roster; a team with an
  `externalGroup` never has its roster diffed.
- Write no `Ruleset` and the org's rulesets are never read, reported, or
  pruned. Declare one and the definition owns the surface: live rulesets
  missing from it become deletes, gated like everything else.

Within a resource, only the fields you write are compared. GitHub returns
every field it knows, defaults included, so `plan` asks whether the live
resource already says everything you asked for rather than whether the two
are identical. Adopting one setting does not reset its neighbours.

### Constructs

The authoring API, all exported from `src/index.ts`.

#### Organization and UserAccount

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
[`examples/personal.ts`](examples/personal.ts).

#### Team

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

#### Grant helpers

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

#### Repository and BranchProtection

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

#### Ruleset

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

#### CustomProperty

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

#### ActionsPolicy

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

#### CodeSecurityConfiguration

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

#### CustomRepositoryRole

```ts
new CustomRepositoryRole(org, "Merge Queue Jumper", {
  description: "Bypass the merge queue",
  baseRole: "push",
  permissions: ["bypass_branch_protection"],
});
```

A custom role ranks as the built-in it extends, which is how grants through
it compare against inherited access.

#### OrganizationRole

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

### The diff tree

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

### Warnings

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

### What GitHub does not expose

- **Enterprise-level policy** is patchy: some REST, some GraphQL, and the
  fine-grained PAT and GitHub App installation policies are UI only. None of
  it is modelled here.
- **Outside collaborator invites** have no field on `PATCH /orgs`, despite
  being a member privilege in the UI.
- **No endpoint lists an organization's protected branches**, which is why
  legacy protection is only ever read for branches the definition names, and
  never pruned.
- **The audit log API** reports what happened. It enforces nothing, so it has
  no place in a desired-state tool.

### Project layout

```
src/
  constructs/   the authoring API: App, Organization, UserAccount, Team,
                OrganizationRole, CustomRepositoryRole, Ruleset, ActionsPolicy,
                CodeSecurityConfiguration, CustomProperty, Repository,
                BranchProtection, and the grant helpers
  synth/        synthesizer + manifest types (teams in manifest.ts, org policy
                in governance.ts, branch-protection.ts), manifest validation,
                warnings
  github/       Octokit client wrapper (throttled and retrying), key casing,
                token resolution
  reconcile/    the change model, live-state reader, planner and applier
                (teams in planner.ts/applier.ts, policy in plan-governance.ts/
                apply-governance.ts), backups and the rollback manifest,
                subset comparison, plan rendering; tree.ts + tree-diff.ts +
                render-tree.ts build and compare the org as a tree for `diff`,
                access-by-person.ts + render-person.ts pivot it onto people,
                plan-org-roles.ts diffs who holds each organization role
  cli.ts        synth | diff | plan | apply
bin/cdkgithub.ts
examples/factbird.ts   example org definition
examples/personal.ts   example personal-account definition
scripts/import-org.ts  dump a live org's teams into a definition
cicd/main.ts           CI workflow, defined with @factbird/cdkactions
.github/workflows/     generated, do not edit by hand
test/                  bun tests against an in-memory GitHub fake
```

### CI and development

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

## Design notes

### The organization is code

Team structure and org policy managed by hand in the GitHub UI drift, and
nobody can review them. Moving them into git makes every change a pull
request, and `plan` the thing a reviewer approves. The definition is edited
far more often than the organization restructures, and that asymmetry drives
most of the decisions below.

### Identity is the slug

GitHub addresses a team by the slug it derives from the name, so cdkgithub
keys identity there too rather than inventing its own. The cost is that a
rename looks like a delete plus a create until the definition says otherwise,
which is what `previousSlug` is for. During an apply, the slug GitHub returns
from the rename, not the locally derived guess, addresses the rest of the
run, because slug derivation is GitHub's and collisions append suffixes the
definition cannot predict.

### A surface is unmanaged until declared

Absence means "leave it alone", never "remove it". This is what lets a
definition covering only the team tree run on a token that only reaches
teams, lets an organization adopt the tool one surface at a time, and keeps
`plan` from proposing to strip settings nobody has written down yet. The
price is that declaring a surface is a commitment: the moment one ruleset is
declared, every live ruleset is either in the definition or on the delete
list.

### Destructive changes are gated three times

A deletion has to pass the plan (visible, marked), the gate
(`--allow-delete`, scoped to kinds), and the prompt (`--require-approval`,
interactive by default). The layers exist because they fail differently: the
plan catches what a reviewer reads, the gate catches a flag passed out of
habit, and the prompt catches the run where the manifest is staler than the
operator thinks. The mass-delete guard is the backstop for the worst version
of that: a truncated manifest turning most of the organization into delete
candidates is refused outright unless `--force` says the restructuring is
real.

### Backups instead of a state file

cdkgithub keeps no state between runs: every plan reads the live
organization and diffs it against the manifest, so there is no state file to
corrupt, lock, or drift, and "state surgery" is not a failure mode. What a
state file would have provided, the ability to put things back, comes from
the backup instead: the live state read before an apply is saved next to a
rollback manifest generated from it, and the journal records how far a run
got. The AWS CDK delegates this problem to CloudFormation; there is no
CloudFormation for a GitHub organization, so the applier carries its own
undo.

### Repositories are never deleted

The edit that drops a repository from a team looks identical to the edit
that drops it from the company, and only one of those is recoverable. So
removing a repository from a definition removes grants, never the
repository, and the client has no delete or transfer call for repositories
at all. A source-grepping test keeps it that way. Archiving, transferring,
and deleting stay in GitHub's own hands, where they are one deliberate
action rather than a consequence of an edit.

### Inherited access is reported but not removable

GitHub reports a child team's repositories as including everything its
ancestors reach, and a parent's members as including everyone below it, and
neither is removable where it is reported. So the planner proposes a removal
only when the team tree does not already explain what it found, and the live
reader fetches ancestors' grants and descendants' rosters alongside every
declaring team to make that explanation possible. Without this, a faithful
definition would propose the same impossible deletions on every run.

### Maintaining is a claim, not a level

`maintain` is write plus the repository's own presentation, which is the
whole of what answering for a repository needs, so maintainership is not a
setting to choose per repository. `maintain` and `admin` both make the
claim, one team holds it per repository, and the conflict fails synthesis
because it is a conflict in the definition, not in the organization. Access
below that level overlaps freely, because reading and writing are not claims
about responsibility.

### Rulesets over legacy branch protection

An organization ruleset applies across repositories, including ones nobody
has created yet, and a repository-level rule can only tighten it. Legacy
protection guards one branch of one repository, and where both apply GitHub
enforces the stricter rule, so the effective policy stops being readable
from either declaration. That is why declaring legacy protection on an
organization warns, why the overlap warns louder, and why the supported
direction is the migration in the how-to guide. On a personal account the
legacy API is simply the API, and nothing warns.

### Organization roles are printed even when undeclared

Five predefined roles carry a repository permission on every repository at
once, so a role assignment is the widest access path in an organization and
the least visible. A team diff cannot show it. That is why `plan` reads
every role whenever the definition declares any, and prints the assignments
nothing accounts for, whether or not you asked.

### Personal accounts fail loud

Teams, rulesets, and the rest are organization features. Declaring one under
a `UserAccount` fails synthesis with the constructs named, because a manifest
that can never apply is worse than an error at the moment the mistake is
written.

### diff and plan answer different questions

`plan` reads only the surfaces the definition declares and lists the calls
`apply` would make. `diff` reads every team whole, several calls per team,
because its question is what the organization looks like, drift included,
next to what the definition says. Reading the whole organization is the
point of one command and would be waste in the other, which is why they are
two commands rather than one flag.

### apply is not in CI

Running `apply` on merge would impose this repository's structure onto the
real organization as a side effect. Reconciliation is a deliberate act, run
by an operator holding an org-admin token, with the prompt and the gates
between them and a mistake. The planner and applier are still tested on
every push, against an in-memory GitHub fake. End-to-end apply wants a
throwaway sandbox organization first; once one exists, a manual
`workflow_dispatch` job can mint a short-lived token and run `plan` and
`apply` against the sandbox only.

### Not built yet

- The Azure-side SCIM push that provisions groups and users into GitHub. The
  linkage endpoint is wired; configuring Entra and enabling SCIM on the
  organization is separate work.
- Repository-level rulesets, runner groups, and organization or repository
  secrets and variables. All have REST endpoints and would fit the model.
- Importing governance. `scripts/import-org.ts` reads teams only, so an
  organization that already has rulesets writes them down by hand once.
- Enterprise-level policy, blocked until GitHub exposes an API that covers it.

### Non-goals

- Multi-language publishing via jsii. cdkgithub is TypeScript, by decision
  rather than by schedule.
