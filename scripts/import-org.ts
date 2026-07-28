/**
 * One-shot importer: read the LIVE GitHub org team structure and emit a
 * cdkgithub stack definition (the inverse of `synth`). Use it to bootstrap a
 * declarative definition from an org that was built by hand in the UI, then
 * iterate on the generated file.
 *
 *   bun scripts/import-org.ts <org> > examples/<org>.ts
 *
 * Auth: uses `gh auth token` (needs `read:org`). Reads teams, their parent
 * hierarchy, per-team repo grants, and members/maintainers.
 *
 * Notes on fidelity:
 *  - GitHub's `role_name` friendly values are mapped to the cdkgithub
 *    RepoPermission enum (read→pull, write→push; triage/maintain/admin as-is).
 *    Custom repository roles (e.g. "Merge Queue Jumper") have no enum value and
 *    are emitted as commented-out lines so the file still typechecks.
 *  - The team members endpoint returns inherited members too (a child team's
 *    members are also members of its parent). We subtract descendants so each
 *    team lists only its DIRECT members — matching a declarative source of truth.
 */

export {};

interface RawTeam {
  slug: string;
  name: string;
  description: string | null;
  privacy: string;
  parent: { slug: string } | null;
}

const ROLE_MAP: Record<string, string> = {
  read: 'pull',
  triage: 'triage',
  write: 'push',
  maintain: 'maintain',
  admin: 'admin',
};

async function gh<T>(path: string): Promise<T> {
  const proc = Bun.spawn(['gh', 'api', '--paginate', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh api ${path} failed: ${err}`);
  // --paginate concatenates JSON arrays as `][` — stitch them into one array.
  return JSON.parse(out.replace(/]\s*\[/g, ',')) as T;
}

const org = process.argv[2];
if (!org) {
  console.error('usage: bun scripts/import-org.ts <org>');
  process.exit(1);
}

const rawTeams = await gh<RawTeam[]>(`orgs/${org}/teams`);

interface Team {
  slug: string;
  name: string;
  description: string | null;
  privacy: string;
  parent: string | null;
  repos: Array<{ name: string; permission: string | null; raw: string }>;
  maintainers: string[];
  members: string[]; // may include inherited; narrowed to direct below
}

const teams: Team[] = [];
for (const t of rawTeams) {
  const repos = await gh<Array<{ name: string; role_name: string }>>(
    `orgs/${org}/teams/${t.slug}/repos`,
  );
  const maintainers = (
    await gh<Array<{ login: string }>>(
      `orgs/${org}/teams/${t.slug}/members?role=maintainer`,
    )
  ).map((m) => m.login);
  const members = (
    await gh<Array<{ login: string }>>(
      `orgs/${org}/teams/${t.slug}/members?role=member`,
    )
  ).map((m) => m.login);
  teams.push({
    slug: t.slug,
    name: t.name,
    description: t.description,
    privacy: t.privacy,
    parent: t.parent?.slug ?? null,
    repos: repos
      .map((r) => ({
        name: r.name,
        permission: ROLE_MAP[r.role_name] ?? null,
        raw: r.role_name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    maintainers: maintainers.sort(),
    members: members.sort(),
  });
}

const bySlug = new Map(teams.map((t) => [t.slug, t]));
const childrenOf = (slug: string) => teams.filter((t) => t.parent === slug);

function descendants(slug: string): Team[] {
  const out: Team[] = [];
  for (const c of childrenOf(slug)) {
    out.push(c, ...descendants(c.slug));
  }
  return out;
}

// Narrow to DIRECT members: drop anyone who is a member/maintainer of any
// descendant team (GitHub reports those as inherited members of the parent).
for (const t of teams) {
  const inherited = new Set<string>();
  for (const d of descendants(t.slug)) {
    d.members.forEach((m) => inherited.add(m));
    d.maintainers.forEach((m) => inherited.add(m));
  }
  t.members = t.members.filter((m) => !inherited.has(m));
}

// ---- emit ----------------------------------------------------------------

const varName = (slug: string) =>
  slug.replace(/[^a-z0-9]+([a-z0-9])/gi, (_, c) => c.toUpperCase());

const q = (s: string) => JSON.stringify(s);
const arr = (xs: string[]) => `[${xs.map(q).join(', ')}]`;

function repoLines(t: Team, indent: string): string {
  const known = t.repos.filter((r) => r.permission);
  const custom = t.repos.filter((r) => !r.permission);
  const lines = known.map((r) => `${indent}${q(r.name)}: ${q(r.permission!)},`);
  for (const r of custom) {
    lines.push(
      `${indent}// ${q(r.name)}: custom role ${q(r.raw)} — not representable in RepoPermission`,
    );
  }
  return lines.join('\n');
}

function emitTeam(t: Team, scopeVar: string): string {
  const v = varName(t.slug);
  const props: string[] = [];
  if (t.name !== t.slug) props.push(`  name: ${q(t.name)},`);
  if (t.description) props.push(`  description: ${q(t.description)},`);
  props.push(`  privacy: ${q(t.privacy)},`);
  if (t.maintainers.length) props.push(`  maintainers: ${arr(t.maintainers)},`);
  if (t.members.length) props.push(`  members: ${arr(t.members)},`);
  if (t.repos.length) {
    props.push(`  repositories: {`);
    props.push(repoLines(t, '    '));
    props.push(`  },`);
  }
  const hasChildren = childrenOf(t.slug).length > 0;
  const decl = hasChildren ? `const ${v} = ` : '';
  return `${decl}new Team(${scopeVar}, ${q(t.slug)}, {\n${props.join('\n')}\n});`;
}

function emitSubtree(slug: string, scopeVar: string, chunks: string[]) {
  const t = bySlug.get(slug)!;
  chunks.push(emitTeam(t, scopeVar));
  const kids = childrenOf(slug).sort((a, b) => a.slug.localeCompare(b.slug));
  for (const c of kids) emitSubtree(c.slug, varName(slug), chunks);
}

const roots = teams
  .filter((t) => !t.parent)
  .sort((a, b) => a.slug.localeCompare(b.slug));

const chunks: string[] = [];
for (const r of roots) {
  emitSubtree(r.slug, 'org', chunks);
  chunks.push(''); // blank line between top-level subtrees
}

const header = `/**
 * ${org} organization team structure — IMPORTED FROM THE LIVE ORG.
 *
 * Generated by \`bun scripts/import-org.ts ${org}\` as a starting point for
 * revising team → repository access declaratively. This mirrors the current
 * live state; edit it, then \`bun bin/cdkgithub.ts synth\` + \`plan\` to preview.
 *
 * Hierarchy is expressed through the construct tree (a Team scoped under another
 * Team is a GitHub child team). NOTE: on GitHub, child teams INHERIT the parent
 * team's repository access — many child teams below re-declare their parent's
 * exact repo list, which is redundant and a prime target to simplify.
 */
import { App, Organization, Team } from "../src/index.ts";

const app = new App();
const org = new Organization(app, ${q(org)}, { login: ${q(org)} });

`;

console.log(header + chunks.join('\n') + '\napp.synth();\n');
