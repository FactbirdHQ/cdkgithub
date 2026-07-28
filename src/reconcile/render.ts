import type { Change } from "./changes.ts";

/** Render a plan as a human-readable, Terraform-flavored summary. */
export function renderPlan(changes: Change[]): string {
  if (changes.length === 0) {
    return "No changes. The organization matches the desired state.";
  }

  const lines: string[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case "create": {
        const t = change.team;
        lines.push(`  + team ${t.slug}${t.parentSlug ? ` (under ${t.parentSlug})` : ""}`);
        lines.push(`      name       = "${t.name}"`);
        if (t.description) lines.push(`      description = "${t.description}"`);
        lines.push(`      privacy    = "${t.privacy}"`);
        if (t.maintainers.length) lines.push(`      maintainers = ${JSON.stringify(t.maintainers)}`);
        if (t.members.length) lines.push(`      members     = ${JSON.stringify(t.members)}`);
        for (const [repo, perm] of Object.entries(t.repositories)) {
          lines.push(`      repo ${repo} = "${perm}"`);
        }
        break;
      }
      case "update": {
        lines.push(`  ~ team ${change.slug}`);
        for (const f of change.fields) {
          lines.push(`      ${f.field}: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`);
        }
        break;
      }
      case "delete": {
        lines.push(`  - team ${change.live.slug}   (requires --allow-delete)`);
        break;
      }
      case "link-group": {
        const g = change.group;
        const ref = g.id !== undefined ? `id ${g.id}` : `"${g.name}"`;
        lines.push(`  ⇄ link team ${change.slug} → Entra group ${ref}   (SCIM, requires --enable-scim)`);
        break;
      }
    }
  }

  const counts = summarize(changes);
  lines.push("");
  lines.push(
    `Plan: ${counts.create} to create, ${counts.update} to update, ${counts.link} to link, ${counts.delete} to delete.`,
  );
  return lines.join("\n");
}

export function summarize(changes: Change[]): {
  create: number;
  update: number;
  delete: number;
  link: number;
} {
  return {
    create: changes.filter((c) => c.kind === "create").length,
    update: changes.filter((c) => c.kind === "update").length,
    delete: changes.filter((c) => c.kind === "delete").length,
    link: changes.filter((c) => c.kind === "link-group").length,
  };
}
