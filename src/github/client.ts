import { Octokit } from "@octokit/rest";
import type { RepoPermission, TeamPrivacy } from "../synth/manifest.ts";

/** Live representation of a team as read back from GitHub. */
export interface LiveTeam {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly privacy: TeamPrivacy;
  /** Slug of the parent team, or null if top-level. */
  readonly parentSlug: string | null;
}

/** An Entra ID (Azure AD) security group exposed to GitHub via SCIM. */
export interface ExternalIdpGroup {
  readonly id: number;
  readonly name: string;
}

/** Shape of `GET /orgs/{org}/external-groups` (not covered by Octokit's typed methods). */
interface ExternalGroupsResponse {
  groups?: Array<{ group_id: number | string; group_name: string }>;
}

export interface CreateTeamParams {
  readonly name: string;
  readonly description?: string;
  readonly privacy: TeamPrivacy;
  /** Numeric id of the parent team, if nested. */
  readonly parentTeamId?: number;
}

export interface UpdateTeamParams {
  readonly name?: string;
  readonly description?: string;
  readonly privacy?: TeamPrivacy;
  /** Numeric id of the parent team, or null to detach. */
  readonly parentTeamId?: number | null;
}

/**
 * Thin, typed surface over the GitHub API used by the reconciler. Kept as an
 * interface so tests can supply an in-memory fake without touching the network.
 */
export interface GitHubClient {
  listTeams(org: string): Promise<LiveTeam[]>;
  createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam>;
  updateTeam(org: string, slug: string, params: UpdateTeamParams): Promise<void>;
  deleteTeam(org: string, slug: string): Promise<void>;
  setMembership(
    org: string,
    slug: string,
    username: string,
    role: "member" | "maintainer",
  ): Promise<void>;
  setRepoPermission(
    org: string,
    slug: string,
    repo: string,
    permission: RepoPermission,
  ): Promise<void>;
  listExternalGroups(org: string): Promise<ExternalIdpGroup[]>;
  linkExternalGroup(org: string, slug: string, groupId: number): Promise<void>;
}

/** Default {@link GitHubClient} backed by Octokit against api.github.com. */
export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;

  constructor(token: string, baseUrl?: string) {
    this.octokit = new Octokit({ auth: token, baseUrl });
  }

  async listTeams(org: string): Promise<LiveTeam[]> {
    const teams = await this.octokit.paginate(this.octokit.rest.teams.list, {
      org,
      per_page: 100,
    });
    return teams.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description ?? null,
      privacy: (t.privacy as TeamPrivacy) ?? "closed",
      parentSlug: t.parent?.slug ?? null,
    }));
  }

  async createTeam(org: string, params: CreateTeamParams): Promise<LiveTeam> {
    const { data } = await this.octokit.rest.teams.create({
      org,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      parent_team_id: params.parentTeamId,
    });
    return {
      id: data.id,
      slug: data.slug,
      name: data.name,
      description: data.description ?? null,
      privacy: (data.privacy as TeamPrivacy) ?? "closed",
      parentSlug: data.parent?.slug ?? null,
    };
  }

  async updateTeam(
    org: string,
    slug: string,
    params: UpdateTeamParams,
  ): Promise<void> {
    await this.octokit.rest.teams.updateInOrg({
      org,
      team_slug: slug,
      name: params.name,
      description: params.description,
      privacy: params.privacy,
      parent_team_id: params.parentTeamId,
    });
  }

  async deleteTeam(org: string, slug: string): Promise<void> {
    await this.octokit.rest.teams.deleteInOrg({ org, team_slug: slug });
  }

  async setMembership(
    org: string,
    slug: string,
    username: string,
    role: "member" | "maintainer",
  ): Promise<void> {
    await this.octokit.rest.teams.addOrUpdateMembershipForUserInOrg({
      org,
      team_slug: slug,
      username,
      role,
    });
  }

  async setRepoPermission(
    org: string,
    slug: string,
    repo: string,
    permission: RepoPermission,
  ): Promise<void> {
    await this.octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
      org,
      team_slug: slug,
      owner: org,
      repo,
      permission,
    });
  }

  // The external-groups endpoints are not in Octokit's generated typed methods,
  // so we call them via the raw request route and type the response ourselves.
  // See: https://docs.github.com/en/enterprise-cloud@latest/rest/teams/external-groups

  async listExternalGroups(org: string): Promise<ExternalIdpGroup[]> {
    const { data } = await this.octokit.request(
      "GET /orgs/{org}/external-groups",
      { org },
    );
    const groups = (data as ExternalGroupsResponse).groups ?? [];
    return groups.map((g) => ({ id: Number(g.group_id), name: g.group_name }));
  }

  async linkExternalGroup(
    org: string,
    slug: string,
    groupId: number,
  ): Promise<void> {
    await this.octokit.request(
      "PATCH /orgs/{org}/teams/{team_slug}/external-groups",
      { org, team_slug: slug, group_id: groupId },
    );
  }
}
