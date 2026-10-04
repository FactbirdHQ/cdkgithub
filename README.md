# cdkgithub

**Declare your GitHub organization in TypeScript. Review it in a pull request.
Apply it with a plan you have read.**

Teams and their hierarchy, repository access, Entra ID group links, rulesets
at both the organization and the repository level, the Actions policy, runner
groups, Actions secrets and variables, code security configurations, custom
properties, issue fields, member privileges, and branch protection live in one definition
in git. cdkgithub diffs that definition against the live organization and
applies the difference over the GitHub REST API. It is built on
[`constructs`](https://www.npmjs.com/package/constructs), the library under
the AWS CDK, cdk8s, and cdktf, and it keeps the CDK's interface: `synth`,
`diff`, an assembly directory, `--require-approval`.

```ts
const org = new Organization(app, "factbird", { login: "factbird" });

const engineering = new Team(org, "engineering", {
  externalGroup: { name: "GH-Engineering" },   // roster driven by Entra ID
});

new Team(engineering, "platform", {            // nested, so a child team
  repositories: [maintain("flow-portal")],
});
```

```
Plan for organization "factbird":

  + team platform (under engineering)
  ~ team cloud on netcore: "push" -> "maintain"
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
- Secret values never touch the definition, the manifest, the plan, or the
  backups. A secret names the environment variable its value comes from, and
  `apply` seals it to GitHub's public key in process.

New to the tool? Start with [Getting started](#getting-started). Mid-task?
[How-to guides](docs/how-to.md). Looking up a flag or a field?
[Reference](docs/reference.md). Wondering why it behaves the way it does?
[Design notes](docs/design.md).

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
   bun src/bin/cdkgithub.ts synth examples/my-org.ts
   ```

   This writes `github.out/manifest.json` and prints nothing when the
   definition is clean.

4. Compare the definition against the live organization, read-only:

   ```bash
   bun src/bin/cdkgithub.ts diff
   ```

   The output is your organization as a tree. The two new teams appear with a
   `+` in the gutter; teams the definition does not mention are listed
   unmarked.

5. Preview the exact changes an apply would make, still read-only:

   ```bash
   bun src/bin/cdkgithub.ts plan
   ```

   Expect two lines, `+ team engineering` and
   `+ team platform (under engineering)`, and a summary saying two creates.

6. Apply:

   ```bash
   bun src/bin/cdkgithub.ts apply --yes
   ```

   The plan prints again, a backup directory is announced, and the two teams
   are created. Creating is not destructive, so there is no prompt. Run
   `bun src/bin/cdkgithub.ts plan` once more and it reports that the organization
   matches the desired state.

7. Commit `examples/my-org.ts`. The definition is now the reviewable record
   of your team structure, and every later change starts as an edit to it.

From here, the [how-to guides](docs/how-to.md) cover the next tasks, from
owning rosters to importing an existing organization, the
[reference](docs/reference.md) documents every command, flag, and construct,
and the [design notes](docs/design.md) say why the tool behaves as it does.

## License

[Apache License 2.0](LICENSE).
