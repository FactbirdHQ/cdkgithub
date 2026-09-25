# How-to guides

## Rename a team

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

## Own a team's roster and repository access

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

## Grant access through a custom repository role

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

## Assign organization roles

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

## Provision Entra ID groups into GitHub (SCIM)

A team's `externalGroup` binding links a group that already exists on
GitHub's side; this is how the group gets there. Declare the Entra side once:

```ts
new ScimProvisioning(org, "entra", {
  tenantId: "contoso.onmicrosoft.com",
});
```

The groups to provision default to every `externalGroup` name the teams
declare, so a team added with a new group is provisioned on the next run
without a second edit; pass `groups` to override. Nothing secret enters the
definition: the GitHub token Entra presents when provisioning is read at run
time from the environment variable `tokenFrom` names
(default `GITHUB_SCIM_TOKEN`).

Sign into the declared tenant (`az login`, or export `AZURE_GRAPH_TOKEN`),
export the token, and run the setup:

```bash
export GITHUB_SCIM_TOKEN=...   # classic token with admin:org
bun bin/cdkgithub.ts scim        # read-only plan
bun bin/cdkgithub.ts scim --yes  # configure Entra
```

The command is ensure-only and idempotent: it creates the enterprise
application from GitHub's gallery template when it is missing, creates its
provisioning job, writes the credentials, assigns the declared groups, and
starts the job. Reruns propose only what is missing; a group assigned in
Entra outside the definition is reported and left alone, and exporting the
token on a later run rotates the stored credential. A run against the wrong
tenant refuses, naming both tenants.

Two steps stay manual, because no public API covers them: creating the
GitHub token, and enabling SCIM on the GitHub organization. Once
provisioning has run (Entra schedules it, up to 40 minutes), the command
reports which declared groups GitHub can see, and linking below takes over.

## Link a team to an Entra ID security group

Prerequisites: GitHub Enterprise Cloud with SCIM provisioning or Enterprise
Managed Users, Entra ID configured as the IdP, and the security group
provisioned to GitHub, which `cdkgithub scim` above sets up. With Entra ID
only security groups link, no nested groups and no Microsoft 365 groups
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

## Declare Actions secrets without their values

A secret's declaration carries its name and who reads it; the value lives in
the environment, named by `valueFrom` (default: the secret's own name):

```ts
new ActionsSecret(org, "NPM_TOKEN", { visibility: "private" });

const deck = new Repository(org, "flight-deck");
new ActionsSecret(deck, "SENTRY_DSN", { valueFrom: "DECK_SENTRY_DSN" });
```

Export the values before applying:

```bash
export NPM_TOKEN=... DECK_SENTRY_DSN=...
bun bin/cdkgithub.ts apply --yes
```

`apply` checks every needed export before writing anything and refuses with
the missing names, so a forgotten one never strands a half-applied plan. The
value is sealed to GitHub's public key in process and pushed when the secret
is created and again on any update; nothing plaintext reaches the manifest,
the plan, or the backups.

GitHub cannot report whether a stored value is current, so `plan` diffs a
secret's existence and visibility only. To rotate a value in place, change
any declared field, or delete and redeclare the secret.

## Adopt an organization built by hand

Bootstrap a definition from the live organization instead of writing it from
scratch:

```bash
bun bin/cdkgithub.ts import <org> --output examples/<org>.ts
```

The importer reads the whole team structure (hierarchy, per-team grants,
direct rosters) and the organization governance: settings, the Actions
policy, custom repository roles, organization role assignments, rulesets,
code security configurations, custom properties with their values, runner
groups, and Actions variables and secrets. A surface the token cannot read is
skipped and named in the generated header rather than failed on. Secrets come
back as names only, so each is emitted reading its value from an environment
variable of the same name.

The repository-scoped surfaces have no organization-wide listing, so reading
them means one round of requests per repository, and the walk is opt-in:

```bash
bun bin/cdkgithub.ts import <org> --repositories --output examples/<org>.ts
bun bin/cdkgithub.ts import <org> --repositories=nest,flight-deck
```

Bare, the flag walks every repository; with names, only those. Each
repository that carries a ruleset, a variable, or a secret of its own is
emitted as a `Repository` block with them nested under it. Branch protection
stays manual either way; rulesets are its successor.

Then iterate: `synth`, `diff`, and trim until the diff is quiet.

## Lock names down at compile time

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

## Run an access review

Pivot the diff onto people rather than teams:

```bash
bun bin/cdkgithub.ts diff --by-person                 # who reaches what, before and after
bun bin/cdkgithub.ts diff --by-person --changed-only  # only people something happens to
bun bin/cdkgithub.ts diff --csv > access.csv          # one row per person per repository
```

One access path sits outside the team structure and needs checking by hand:
organization owners reach every repository whatever the teams say. A
collaborator added to a single repository shows in the review once the
definition declares collaborators, credited to `direct collaborator`. `plan`
prints another: organization role assignments the definition does not
account for, which reach further than any team grant. The plain `diff` also
lists repositories no team reaches and the definition does not declare, each
one a repository with no maintainer written down anywhere.

## Migrate legacy branch protection to a ruleset

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

## Revert an apply

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

## Run apply from automation

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
