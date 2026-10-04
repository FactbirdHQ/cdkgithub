/**
 * The definition the README recording synthesizes, plans and applies.
 * It mirrors the README's example.
 */
import { App, maintain, Organization, Team } from '../../src/index.ts';

const app = new App();

const org = new Organization(app, 'factbird', { login: 'factbird' });

const engineering = new Team(org, 'engineering');

new Team(engineering, 'platform', {
  repositories: [maintain('flow-portal')],
});

new Team(org, 'cloud', {
  repositories: [maintain('netcore')],
});

app.synth();
