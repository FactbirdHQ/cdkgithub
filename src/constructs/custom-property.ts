import { Construct } from 'constructs';
import type { CustomPropertyValueType } from '../synth/governance.ts';

export interface CustomPropertyProps {
  /** Property name as repositories see it. Defaults to the construct id. */
  readonly name?: string;

  readonly valueType: CustomPropertyValueType;

  /** Require every repository to carry a value for this property. */
  readonly required?: boolean;

  /** Value new repositories start with. Required by GitHub when `required` is set. */
  readonly defaultValue?: string | string[] | null;

  readonly description?: string | null;

  /** The permitted values for `single_select` and `multi_select`. */
  readonly allowedValues?: string[] | null;

  /** Who may change a repository's value. Defaults to org actors only. */
  readonly valuesEditableBy?: 'org_actors' | 'org_and_repo_actors' | null;

  /**
   * Per-repository values, `{ "flight-deck": "tier-1" }`. Declared here so a
   * property and the repositories it classifies stay in one place.
   */
  readonly values?: Record<string, string | string[] | null>;
}

/**
 * A repository custom property.
 *
 * Properties are how an org classifies its repositories, and a {@link Ruleset}
 * can target a class rather than a list of names — so the ruleset survives every
 * new repository without an edit.
 *
 * ```ts
 * new CustomProperty(org, 'service-tier', {
 *   valueType: 'single_select',
 *   allowedValues: ['tier-1', 'tier-2', 'internal'],
 *   required: true,
 *   defaultValue: 'internal',
 *   values: { 'flight-deck': 'tier-1' },
 * });
 * ```
 */
export class CustomProperty extends Construct {
  public readonly propertyName: string;
  public readonly props: CustomPropertyProps;

  constructor(scope: Construct, id: string, props: CustomPropertyProps) {
    super(scope, id);
    this.props = props;
    this.propertyName = props.name ?? id;
  }
}
