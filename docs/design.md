# Design notes

## The organization is code

Team structure and org policy managed by hand in the GitHub UI drift, and
nobody can review them. Moving them into git makes every change a pull
request, and `plan` the thing a reviewer approves. The definition is edited
far more often than the organization restructures, and that asymmetry drives
most of the decisions below.

## Identity is the slug

GitHub addresses a team by the slug it derives from the name, so cdkgithub
keys identity there too rather than inventing its own. The cost is that a
rename looks like a delete plus a create until the definition says otherwise,
which is what `previousSlug` is for. During an apply, the slug GitHub returns
from the rename, not the locally derived guess, addresses the rest of the
run, because slug derivation is GitHub's and collisions append suffixes the
definition cannot predict.

## A surface is unmanaged until declared

Absence means "leave it alone", never "remove it". This is what lets a
definition covering only the team tree run on a token that only reaches
teams, lets an organization adopt the tool one surface at a time, and keeps
`plan` from proposing to strip settings nobody has written down yet. The
price is that declaring a surface is a commitment: the moment one ruleset is
declared, every live ruleset is either in the definition or on the delete
list.

## Destructive changes are gated three times

A deletion has to pass the plan (visible, marked), the gate
(`--allow-delete`, scoped to kinds), and the prompt (`--require-approval`,
interactive by default). The layers exist because they fail differently: the
plan catches what a reviewer reads, the gate catches a flag passed out of
habit, and the prompt catches the run where the manifest is staler than the
operator thinks. The mass-delete guard is the backstop for the worst version
of that: a truncated manifest turning most of the organization into delete
candidates is refused outright unless `--force` says the restructuring is
real.

## Backups instead of a state file

cdkgithub keeps no state between runs: every plan reads the live
organization and diffs it against the manifest, so there is no state file to
corrupt, lock, or drift, and "state surgery" is not a failure mode. What a
state file would have provided, the ability to put things back, comes from
the backup instead: the live state read before an apply is saved next to a
rollback manifest generated from it, and the journal records how far a run
got. The AWS CDK delegates this problem to CloudFormation; there is no
CloudFormation for a GitHub organization, so the applier carries its own
undo.

## Repositories are never deleted

The edit that drops a repository from a team looks identical to the edit
that drops it from the company, and only one of those is recoverable. So
removing a repository from a definition removes grants, never the
repository, and the client has no delete or transfer call for repositories
at all. A source-grepping test keeps it that way. Archiving, transferring,
and deleting stay in GitHub's own hands, where they are one deliberate
action rather than a consequence of an edit.

## Inherited access is reported but not removable

GitHub reports a child team's repositories as including everything its
ancestors reach, and a parent's members as including everyone below it, and
neither is removable where it is reported. So the planner proposes a removal
only when the team tree does not already explain what it found, and the live
reader fetches ancestors' grants and descendants' rosters alongside every
declaring team to make that explanation possible. Without this, a faithful
definition would propose the same impossible deletions on every run.

## Maintaining is a claim, not a level

`maintain` is write plus the repository's own presentation, which is the
whole of what answering for a repository needs, so maintainership is not a
setting to choose per repository. `maintain` and `admin` both make the
claim, one team holds it per repository, and the conflict fails synthesis
because it is a conflict in the definition, not in the organization. Access
below that level overlaps freely, because reading and writing are not claims
about responsibility.

## Rulesets over legacy branch protection

An organization ruleset applies across repositories, including ones nobody
has created yet, and a repository-level rule can only tighten it. Legacy
protection guards one branch of one repository, and where both apply GitHub
enforces the stricter rule, so the effective policy stops being readable
from either declaration. That is why declaring legacy protection on an
organization warns, why the overlap warns louder, and why the supported
direction is the migration in the how-to guide. On a personal account the
legacy API is simply the API, and nothing warns.

## Organization roles are printed even when undeclared

Five predefined roles carry a repository permission on every repository at
once, so a role assignment is the widest access path in an organization and
the least visible. A team diff cannot show it. That is why `plan` reads
every role whenever the definition declares any, and prints the assignments
nothing accounts for, whether or not you asked.

## Personal accounts fail loud

Teams, rulesets, and the rest are organization features. Declaring one under
a `UserAccount` fails synthesis with the constructs named, because a manifest
that can never apply is worse than an error at the moment the mistake is
written.

## diff and plan answer different questions

`plan` reads only the surfaces the definition declares and lists the calls
`apply` would make. `diff` reads every team whole, several calls per team,
because its question is what the organization looks like, drift included,
next to what the definition says. Reading the whole organization is the
point of one command and would be waste in the other, which is why they are
two commands rather than one flag.

## apply is not in CI

Running `apply` on merge would impose this repository's structure onto the
real organization as a side effect. Reconciliation is a deliberate act, run
by an operator holding an org-admin token, with the prompt and the gates
between them and a mistake. The planner and applier are still tested on
every push, against an in-memory GitHub fake. End-to-end apply wants a
throwaway sandbox organization first; once one exists, a manual
`workflow_dispatch` job can mint a short-lived token and run `plan` and
`apply` against the sandbox only.

## Not built yet

- Enterprise-level policy, blocked until GitHub exposes an API that covers it.

## Non-goals

- Multi-language publishing via jsii. cdkgithub is TypeScript, by decision
  rather than by schedule.
