import type { Change, FieldChange } from './changes.ts';

/** Render a plan as a human-readable, Terraform-flavored summary. */
export function renderPlan(changes: Change[]): string {
  if (changes.length === 0) {
    return 'No changes. The organization matches the desired state.';
  }

  const lines: string[] = [];
  for (const change of changes) {
    switch (change.kind) {
      case 'create': {
        const t = change.team;
        lines.push(
          `  + team ${t.slug}${t.parentSlug ? ` (under ${t.parentSlug})` : ''}`,
        );
        lines.push(`      name       = "${t.name}"`);
        if (t.description) lines.push(`      description = "${t.description}"`);
        lines.push(`      privacy    = "${t.privacy}"`);
        if (t.maintainers?.length)
          lines.push(`      maintainers = ${JSON.stringify(t.maintainers)}`);
        if (t.members?.length)
          lines.push(`      members     = ${JSON.stringify(t.members)}`);
        for (const [repo, perm] of Object.entries(t.repositories ?? {})) {
          lines.push(`      repo ${repo} = "${perm}"`);
        }
        break;
      }
      case 'update': {
        lines.push(`  ~ team ${change.slug}`);
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'delete': {
        lines.push(`  - team ${change.live.slug}   (requires --allow-delete)`);
        break;
      }
      case 'set-repo-access': {
        const from = change.from ? `"${change.from}" -> ` : '';
        lines.push(
          `  ~ team ${change.slug} on ${change.repository}: ${from}"${change.permission}"`,
        );
        break;
      }
      case 'remove-repo-access': {
        lines.push(
          `  - team ${change.slug} on ${change.repository} ("${change.from}")   (requires --allow-delete)`,
        );
        break;
      }
      case 'set-membership': {
        // `from` is the role the team reports, which may be one the member holds
        // through a team below. Landing on the same role is not a no-op then: it
        // is the membership becoming this team's own.
        const { username, slug, role, from } = change;
        const how =
          from === undefined
            ? `joins ${slug} as "${role}"`
            : from === role
              ? `in ${slug}: inherited -> "${role}"`
              : `in ${slug}: "${from}" -> "${role}"`;
        lines.push(`  ~ ${username} ${how}`);
        break;
      }
      case 'remove-membership': {
        lines.push(
          `  - ${change.username} from ${change.slug} ("${change.from}")   (requires --allow-delete)`,
        );
        break;
      }

      case 'link-group': {
        const g = change.group;
        const ref = g.id !== undefined ? `id ${g.id}` : `"${g.name}"`;
        lines.push(
          `  ⇄ link team ${change.slug} → Entra group ${ref}   (SCIM, requires --enable-scim)`,
        );
        break;
      }

      case 'org-settings': {
        lines.push('  ~ organization settings');
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'actions-policy': {
        lines.push('  ~ actions policy');
        lines.push(...renderFields(change.fields));
        break;
      }

      case 'create-ruleset': {
        const r = change.ruleset;
        lines.push(`  + ruleset "${r.name}"`);
        lines.push(`      target      = "${r.target}"`);
        lines.push(`      enforcement = "${r.enforcement}"`);
        for (const rule of r.rules) lines.push(`      rule ${rule.type}`);
        if (r.conditions)
          lines.push(`      conditions  = ${compact(r.conditions)}`);
        break;
      }
      case 'update-ruleset': {
        lines.push(`  ~ ruleset "${change.ruleset.name}"`);
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'delete-ruleset': {
        lines.push(
          `  - ruleset "${change.live.name}"   (requires --allow-delete)`,
        );
        break;
      }

      case 'create-security-config': {
        lines.push(`  + code security configuration "${change.config.name}"`);
        lines.push(`      description = "${change.config.description}"`);
        break;
      }
      case 'update-security-config': {
        lines.push(`  ~ code security configuration "${change.config.name}"`);
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'delete-security-config': {
        lines.push(
          `  - code security configuration "${change.live.name}"   (requires --allow-delete)`,
        );
        break;
      }
      case 'default-security-config': {
        const from = change.from ? `"${change.from}"` : 'none';
        lines.push(
          `  ~ default for ${change.scope} new repositories: ${from} -> "${change.configName}"`,
        );
        break;
      }
      case 'attach-security-config': {
        const target = change.repositories
          ? change.repositories.join(', ')
          : `${change.scope} repositories`;
        lines.push(`  ⇄ attach "${change.configName}" to ${target}`);
        break;
      }

      case 'create-property': {
        const p = change.property;
        lines.push(`  + custom property "${p.name}"`);
        lines.push(`      value_type = "${p.valueType}"`);
        if (p.allowedValues?.length)
          lines.push(`      allowed    = ${JSON.stringify(p.allowedValues)}`);
        break;
      }
      case 'update-property': {
        lines.push(`  ~ custom property "${change.property.name}"`);
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'delete-property': {
        lines.push(
          `  - custom property "${change.live.name}"   (requires --allow-delete)`,
        );
        break;
      }
      case 'branch-protection': {
        const b = change.protection;
        lines.push(`  ~ branch protection ${b.repository}#${b.branch}`);
        lines.push(...renderFields(change.fields));
        break;
      }
      case 'remove-branch-protection': {
        lines.push(
          `  - branch protection ${change.repository}#${change.branch}`,
        );
        break;
      }
      case 'property-values': {
        lines.push(`  ~ custom property "${change.propertyName}" values`);
        for (const [repo, value] of Object.entries(change.values)) {
          lines.push(`      ${repo} = ${JSON.stringify(value)}`);
        }
        break;
      }
    }
  }

  const counts = summarize(changes);
  lines.push('');
  lines.push(
    `Plan: ${counts.create} to create, ${counts.update} to update, ` +
      `${counts.link} to link, ${counts.delete} to delete.`,
  );
  return lines.join('\n');
}

function renderFields(fields: FieldChange[]): string[] {
  return fields.map(
    (f) => `      ${f.field}: ${compact(f.from)} -> ${compact(f.to)}`,
  );
}

/**
 * A one-line JSON rendering, trimmed. Ruleset rules and conditions are trees;
 * printing them in full would bury the rest of the plan.
 */
function compact(value: unknown, limit = 160): string {
  const json = JSON.stringify(value) ?? 'undefined';
  return json.length <= limit ? json : `${json.slice(0, limit - 1)}…`;
}

const BUCKETS = {
  create: [
    'create',
    'create-ruleset',
    'create-security-config',
    'create-property',
  ],
  update: [
    'update',
    'set-repo-access',
    'set-membership',
    'update-ruleset',
    'update-security-config',
    'update-property',
    'org-settings',
    'actions-policy',
    'default-security-config',
    'property-values',
    'branch-protection',
  ],
  delete: [
    'delete',
    'remove-repo-access',
    'remove-membership',
    'delete-ruleset',
    'delete-security-config',
    'delete-property',
    'remove-branch-protection',
  ],
  link: ['link-group', 'attach-security-config'],
} as const satisfies Record<string, ReadonlyArray<Change['kind']>>;

/** Count the changes per headline bucket, for the one-line plan summary. */
export function summarize(changes: Change[]): {
  create: number;
  update: number;
  delete: number;
  link: number;
} {
  const count = (kinds: ReadonlyArray<Change['kind']>) =>
    changes.filter((c) => kinds.includes(c.kind)).length;

  return {
    create: count(BUCKETS.create),
    update: count(BUCKETS.update),
    delete: count(BUCKETS.delete),
    link: count(BUCKETS.link),
  };
}
