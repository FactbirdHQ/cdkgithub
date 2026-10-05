import { describe, expect, test } from 'bun:test';

import type { Octokit } from '@octokit/rest';

import { type LiveIssueField, OctokitGitHubClient } from '../src/github/client.ts';
import { App, IssueField, Organization } from '../src/index.ts';
import type { LiveState } from '../src/reconcile/live.ts';
import { planIssueFields } from '../src/reconcile/plan-issue-fields.ts';
import { synthesize } from '../src/synth/synthesizer.ts';

const PRIORITY: LiveIssueField = {
  id: 4,
  name: 'Priority',
  dataType: 'single_select',
  description: null,
  visibility: 'organization_members_only',
  options: [
    { id: 40, name: 'P0', description: null, color: 'red' },
    { id: 41, name: 'P1', description: null, color: 'gray' },
  ],
};

const LIVE: LiveState = { teams: [], issueFields: [PRIORITY] };

describe('synthesizing issue fields', () => {
  test('props and add* make the same field, bare options become objects', () => {
    const app = new App();
    const org = new Organization(app, 'acme', {
      login: 'acme',
      issueField: { Effort: { dataType: 'number' } },
    });
    org.addIssueField('Priority', {
      dataType: 'single_select',
      options: [{ name: 'P0', color: 'red' }, 'P1'],
    });

    expect(synthesize(app).issueFields).toEqual([
      { name: 'Effort', dataType: 'number' },
      {
        name: 'Priority',
        dataType: 'single_select',
        options: [{ name: 'P0', color: 'red' }, { name: 'P1' }],
      },
    ]);
  });

  test('a select field needs options', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new IssueField(org, 'Priority', { dataType: 'multi_select' });
    expect(() => synthesize(app)).toThrow(/declares no options/);
  });

  test('a non-select field takes none', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new IssueField(org, 'Due', { dataType: 'date', options: ['x'] });
    expect(() => synthesize(app)).toThrow(/takes no options/);
  });

  test('an option name appears once', () => {
    const app = new App();
    const org = new Organization(app, 'acme', { login: 'acme' });
    new IssueField(org, 'Priority', {
      dataType: 'single_select',
      options: ['P0', { name: 'P0', color: 'red' }],
    });
    expect(() => synthesize(app)).toThrow(/"P0" twice/);
  });
});

describe('planning issue fields', () => {
  test('declaring nothing leaves the surface alone', () => {
    expect(planIssueFields(undefined, LIVE)).toEqual([]);
  });

  test('a matching field is no change, an undeclared color reads as gray', () => {
    const changes = planIssueFields(
      [
        {
          name: 'Priority',
          dataType: 'single_select',
          options: [{ name: 'P0', color: 'red' }, { name: 'P1' }],
        },
      ],
      LIVE,
    );
    expect(changes).toEqual([]);
  });

  test('reordering the options is an update', () => {
    const field = {
      name: 'Priority',
      dataType: 'single_select' as const,
      options: [{ name: 'P1' }, { name: 'P0', color: 'red' as const }],
    };
    expect(planIssueFields([field], LIVE)).toEqual([
      {
        kind: 'update-issue-field',
        live: PRIORITY,
        field,
        fields: [
          {
            field: 'options',
            from: ['P0 [red]', 'P1 [gray]'],
            to: ['P1 [gray]', 'P0 [red]'],
          },
        ],
      },
    ]);
  });

  test('a new name is a create, and the undeclared live field a delete', () => {
    const changes = planIssueFields([{ name: 'Effort', dataType: 'number' }], LIVE);
    expect(changes.map((c) => c.kind)).toEqual(['create-issue-field', 'delete-issue-field']);
  });

  test('a different data type stops the plan', () => {
    expect(() => planIssueFields([{ name: 'Priority', dataType: 'text' }], LIVE)).toThrow(
      /cannot change a field's type in place/,
    );
  });
});

describe('the issue-field client', () => {
  function recording() {
    const calls: Array<{ route: string; params: Record<string, unknown> }> = [];
    const client = new OctokitGitHubClient('token', undefined, {
      request: async (route: string, params: Record<string, unknown>) => {
        calls.push({ route, params });
        if (route === 'GET /orgs/{org}/issue-fields') {
          return {
            data: [
              {
                id: 4,
                name: 'Priority',
                data_type: 'single_select',
                options: [
                  { id: 41, name: 'P1', color: 'gray', priority: 2 },
                  { id: 40, name: 'P0', color: 'red', priority: 1 },
                ],
              },
            ],
          };
        }
        return { data: {} };
      },
    } as unknown as Octokit);
    return { client, calls };
  }

  test('reads options in priority order', async () => {
    const { client } = recording();
    const [field] = await client.listIssueFields('acme');
    expect(field?.options?.map((o) => o.name)).toEqual(['P0', 'P1']);
  });

  test('an update keeps the id of every option it keeps', async () => {
    const { client, calls } = recording();
    await client.updateIssueField('acme', PRIORITY, {
      name: 'Priority',
      dataType: 'single_select',
      options: [{ name: 'P1' }, { name: 'P2', color: 'blue' }],
    });
    expect(calls[0]?.route).toBe('PATCH /orgs/{org}/issue-fields/{issue_field_id}');
    expect(calls[0]?.params).toMatchObject({
      issue_field_id: 4,
      options: [
        { id: 41, name: 'P1', color: 'gray', priority: 1 },
        { id: undefined, name: 'P2', color: 'blue', priority: 2 },
      ],
    });
  });
});
