import { describe, expect, test } from 'bun:test';
import {
  planOrganizationRoles,
  unmanagedRoleAssignments,
} from '../src/reconcile/plan-org-roles.ts';
import type { LiveState } from '../src/reconcile/live.ts';

/** Live state carrying only the roles, which is all these tests read. */
function state(
  roles: Array<{
    id: number;
    name: string;
    baseRole?: string;
    teams: string[];
    users: string[];
  }>,
): LiveState {
  return {
    teams: [],
    organizationRoles: roles.map((r) => ({ ...r, permissions: [] })),
  };
}

const LIVE = state([
  {
    id: 138,
    name: 'security_manager',
    baseRole: 'read',
    teams: ['devops'],
    users: ['ana'],
  },
  {
    id: 8136,
    name: 'all_repo_admin',
    baseRole: 'admin',
    teams: [],
    users: ['bo'],
  },
  { id: 26237, name: 'ci_cd_admin', teams: ['devops'], users: [] },
]);

describe('planning organization roles', () => {
  test('grants a role to someone who does not hold it', () => {
    const changes = planOrganizationRoles(
      [{ name: 'security_manager', users: ['ana', 'newhire'] }],
      LIVE,
    );
    expect(changes).toEqual([
      {
        kind: 'assign-org-role',
        role: 'security_manager',
        roleId: 138,
        subject: 'user',
        name: 'newhire',
      },
    ]);
  });

  test('a surface the definition omits is left alone', () => {
    // `teams` is not declared, so devops keeps the role untouched.
    const changes = planOrganizationRoles(
      [{ name: 'security_manager', users: ['ana'] }],
      LIVE,
    );
    expect(changes).toEqual([]);
  });

  test('an empty declared list revokes what is held', () => {
    const changes = planOrganizationRoles(
      [{ name: 'security_manager', teams: [], users: ['ana'] }],
      LIVE,
    );
    expect(changes).toEqual([
      {
        kind: 'revoke-org-role',
        role: 'security_manager',
        roleId: 138,
        subject: 'team',
        name: 'devops',
      },
    ]);
  });

  test('a role GitHub does not define fails the plan', () => {
    expect(() =>
      planOrganizationRoles(
        [{ name: 'securty_manager', users: ['ana'] }],
        LIVE,
      ),
    ).toThrow(/does not exist in this organization/);
  });

  test('declaring nothing reads nothing', () => {
    expect(planOrganizationRoles(undefined, LIVE)).toEqual([]);
  });
});

describe('reporting what the definition does not own', () => {
  test('names the assignments nobody wrote down', () => {
    const unmanaged = unmanagedRoleAssignments(
      [{ name: 'security_manager', teams: ['devops'], users: ['ana'] }],
      LIVE,
    );
    // security_manager is fully declared, so only the other two remain.
    expect(unmanaged).toEqual([
      { role: 'all_repo_admin', baseRole: 'admin', teams: [], users: ['bo'] },
      {
        role: 'ci_cd_admin',
        baseRole: undefined,
        teams: ['devops'],
        users: [],
      },
    ]);
  });

  test('a declared surface stops being reported, an undeclared one does not', () => {
    const unmanaged = unmanagedRoleAssignments(
      [{ name: 'security_manager', teams: ['devops'] }],
      LIVE,
    );
    const security = unmanaged.find((r) => r.role === 'security_manager');
    expect(security?.teams).toEqual([]);
    expect(security?.users).toEqual(['ana']);
  });

  test('declaring nothing reports every assignment', () => {
    const unmanaged = unmanagedRoleAssignments(undefined, LIVE);
    expect(unmanaged.map((r) => r.role)).toEqual([
      'security_manager',
      'all_repo_admin',
      'ci_cd_admin',
    ]);
  });
});
