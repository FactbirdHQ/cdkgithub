/**
 * A personal account, to show the other half of the owner model.
 *
 * A user has no teams, no organization rulesets, no Actions policy, no code
 * security configurations, and no custom properties. Declaring any of them here
 * fails synthesis rather than writing a manifest that could never apply. What is
 * left is repositories and their branch protection, which is the one place the
 * legacy API is the right tool rather than a leftover, and where cdkgithub does
 * not warn about using it.
 *
 *   bun src/bin/cdkgithub.ts synth examples/personal.ts
 */
import {
  App,
  BranchProtection,
  Repository,
  UserAccount,
} from '../src/index.ts';

const app = new App();

const me = new UserAccount(app, 'martinjlowm', { login: 'martinjlowm' });

const dotfiles = new Repository(me, 'dotfiles');

new BranchProtection(dotfiles, 'main', {
  requiredSignatures: true,
  allowForcePushes: false,
  allowDeletions: false,
  requiredLinearHistory: true,
});

app.synth();
