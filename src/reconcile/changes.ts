import type { ExternalGroupBinding, TeamManifest } from "../synth/manifest.ts";
import type { LiveTeam } from "../github/client.ts";

/** Create a team that exists in the desired state but not on GitHub. */
export interface CreateTeam {
  readonly kind: "create";
  readonly team: TeamManifest;
}

/** A single differing field on an existing team. */
export interface FieldChange<T = unknown> {
  readonly field: string;
  readonly from: T;
  readonly to: T;
}

/** Update core properties of an existing team. */
export interface UpdateTeam {
  readonly kind: "update";
  readonly slug: string;
  readonly team: TeamManifest;
  readonly fields: FieldChange[];
}

/** A team on GitHub that is not present in the desired state. Gated by --allow-delete. */
export interface DeleteTeam {
  readonly kind: "delete";
  readonly live: LiveTeam;
}

/** Ensure a team is linked to its Entra ID security group via SCIM. Gated by --enable-scim. */
export interface LinkExternalGroup {
  readonly kind: "link-group";
  readonly slug: string;
  readonly group: ExternalGroupBinding;
}

export type Change = CreateTeam | UpdateTeam | DeleteTeam | LinkExternalGroup;
