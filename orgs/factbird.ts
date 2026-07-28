/**
 * Example organization definition — the human-authored source of truth for the
 * `factbird` org's team structure. Edit this, run `github-org synth orgs/factbird.ts`,
 * then `github-org plan` to preview and `github-org apply --yes` to reconcile.
 */
import { App, Organization, Team } from "../src/index.ts";

const app = new App();

const org = new Organization(app, "factbird", { login: "factbird" });

// Top-level team, membership driven by an Entra ID security group (SCIM).
const engineering = new Team(org, "engineering", {
  description: "All engineers",
  privacy: "closed",
  externalGroup: { name: "GH-Engineering" }, // Entra security group; linked via SCIM
});

// Nested team: scoped under `engineering`, so it becomes a child team on GitHub.
new Team(engineering, "platform", {
  description: "Platform & infrastructure",
  externalGroup: { name: "GH-Platform" },
  repositories: {
    "flight-deck": "maintain",
    "module-cdk-aws": "push",
  },
});

// A non-synced team whose membership is managed here directly.
new Team(org, "security", {
  description: "Security guild",
  privacy: "secret",
  maintainers: ["mj"],
});

app.synth();
