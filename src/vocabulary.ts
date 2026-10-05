/**
 * The names a definition is allowed to use, declared once by the definition.
 *
 * GitHub's own vocabulary is fixed — five permissions, a handful of role names —
 * but the interesting names belong to an organization: its repositories, its
 * people, the repository roles it defines. This tool cannot know them, so its
 * types leave them open and a misspelling survives until `plan` checks it
 * against the live organization, or until `apply` invites nobody to a team.
 *
 * A definition that knows them says so by augmenting this:
 *
 * ```ts
 * export const USERS = ['ana', 'bo'] as const;
 * export const REPOSITORIES = ['netcore', 'fctl'] as const;
 *
 * declare module '@factbird/cdkgithub' {
 *   interface Vocabulary {
 *     member: (typeof USERS)[number];
 *     repository: (typeof REPOSITORIES)[number];
 *   }
 * }
 * ```
 *
 * From then on every roster and every grant in that project is checked against
 * those lists, with nothing said at the point of use. A project that declares
 * nothing keeps the open types and loses nothing.
 *
 * This is deliberately global, which is the trade it makes. One project cannot
 * hold two organizations with different vocabularies; {@link teamOf} binds a
 * vocabulary locally instead and is the answer where that matters.
 */
export type Vocabulary = {};

/** A person, narrowed to {@link Vocabulary.member} when a definition names one. */
export type VocabularyMember = Vocabulary extends {
  member: infer M extends string;
}
  ? M
  : string;

/**
 * A repository, narrowed to {@link Vocabulary.repository} when a definition
 * names one.
 */
export type VocabularyRepository = Vocabulary extends {
  repository: infer R extends string;
}
  ? R
  : string;
