import { Construct } from 'constructs';
import type {
  SecurityAttachScope,
  SecurityDefaultScope,
  SecurityFeature,
} from '../synth/governance.ts';

export interface CodeSecurityConfigurationProps {
  /** Configuration name, unique in the org. Defaults to the construct id. */
  readonly name?: string;

  /** Required by GitHub; shown next to the configuration in the org settings. */
  readonly description: string;

  /**
   * GitHub Advanced Security. `code_security` and `secret_protection` select the
   * individual products; `enabled` turns on both.
   */
  readonly advancedSecurity?:
    | 'enabled'
    | 'disabled'
    | 'code_security'
    | 'secret_protection';

  readonly dependencyGraph?: SecurityFeature;
  readonly dependencyGraphAutosubmitAction?: SecurityFeature;
  readonly dependabotAlerts?: SecurityFeature;
  readonly dependabotSecurityUpdates?: SecurityFeature;
  readonly codeScanningDefaultSetup?: SecurityFeature;
  readonly secretScanning?: SecurityFeature;
  readonly secretScanningPushProtection?: SecurityFeature;
  readonly secretScanningValidityChecks?: SecurityFeature;
  readonly secretScanningNonProviderPatterns?: SecurityFeature;
  readonly privateVulnerabilityReporting?: SecurityFeature;

  /**
   * `enforced` prevents repository admins from switching the features back off.
   */
  readonly enforcement?: 'enforced' | 'unenforced';

  /** Apply this configuration to new repositories of the given scope. */
  readonly defaultForNewRepos?: SecurityDefaultScope;

  /**
   * Attach the configuration to existing repositories. Attachment is applied on
   * every run rather than diffed, because it is recorded on the repositories.
   */
  readonly attach?: SecurityAttachScope;

  /** Attach to named repositories instead of a scope. */
  readonly attachRepositories?: string[];
}

/**
 * A code security configuration: one bundle of Dependabot, secret scanning, push
 * protection, and code scanning settings that repositories are attached to.
 *
 * ```ts
 * new CodeSecurityConfiguration(org, 'baseline', {
 *   description: 'Secret scanning and Dependabot everywhere',
 *   dependabotAlerts: 'enabled',
 *   secretScanning: 'enabled',
 *   secretScanningPushProtection: 'enabled',
 *   enforcement: 'enforced',
 *   defaultForNewRepos: 'all',
 *   attach: 'all_without_configurations',
 * });
 * ```
 */
export class CodeSecurityConfiguration extends Construct {
  public readonly configurationName: string;
  public readonly props: CodeSecurityConfigurationProps;

  constructor(
    scope: Construct,
    id: string,
    props: CodeSecurityConfigurationProps,
  ) {
    super(scope, id);
    this.props = props;
    this.configurationName = props.name ?? id;
  }
}
