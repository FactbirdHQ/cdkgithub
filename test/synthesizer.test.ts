import { describe, expect, test } from "bun:test";
import { App, Organization, Team } from "../src/index.ts";
import { synthesize } from "../src/synth/synthesizer.ts";

describe("synthesize", () => {
  test("resolves nesting, slugs, defaults, and external groups", () => {
    const app = new App();
    const org = new Organization(app, "acme", { login: "acme" });
    const eng = new Team(org, "engineering", {
      description: "All engineers",
      externalGroup: { name: "GH-Engineering" },
    });
    new Team(eng, "platform", { name: "Platform Team" });

    const state = synthesize(app);

    expect(state.org).toBe("acme");
    const bySlug = Object.fromEntries(state.teams.map((t) => [t.slug, t]));

    // slug derivation from a spaced name
    expect(bySlug["platform-team"]).toBeDefined();
    // privacy defaults to "closed"
    expect(bySlug.engineering!.privacy).toBe("closed");
    // nested team resolves its parent slug
    expect(bySlug["platform-team"]!.parentSlug).toBe("engineering");
    // external group is carried through
    expect(bySlug.engineering!.externalGroup).toEqual({
      name: "GH-Engineering",
      id: undefined,
    });
  });

  test("orders parents before children", () => {
    const app = new App();
    const org = new Organization(app, "acme", { login: "acme" });
    const parent = new Team(org, "parent");
    const child = new Team(parent, "child");
    new Team(child, "grandchild");

    const slugs = synthesize(app).teams.map((t) => t.slug);
    expect(slugs.indexOf("parent")).toBeLessThan(slugs.indexOf("child"));
    expect(slugs.indexOf("child")).toBeLessThan(slugs.indexOf("grandchild"));
  });

  test("throws when no organization is defined", () => {
    const app = new App();
    expect(() => synthesize(app)).toThrow(/No Organization/);
  });

  test("throws on duplicate slugs", () => {
    const app = new App();
    const org = new Organization(app, "acme", { login: "acme" });
    new Team(org, "a", { name: "Dev Team" });
    new Team(org, "b", { name: "dev-team" });
    expect(() => synthesize(app)).toThrow(/Duplicate team slug/);
  });
});
