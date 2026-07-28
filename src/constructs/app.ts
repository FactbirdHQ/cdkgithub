import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Construct } from 'constructs';
import type { DesiredState } from '../synth/manifest.ts';
import { synthesize } from '../synth/synthesizer.ts';

export interface AppProps {
  /**
   * Directory the synthesized manifest is written to.
   * @default "github.out"
   */
  readonly outdir?: string;
}

/**
 * Root of the construct tree. Analogous to a CDK `App`.
 *
 * Define an `Organization` and `Team`s under it, then call `synth()` to emit the
 * desired-state manifest that `plan`/`apply` consume.
 */
export class App extends Construct {
  public readonly outdir: string;

  constructor(props: AppProps = {}) {
    // A root construct has no scope. This mirrors cdk8s/cdktf App roots.
    super(undefined as unknown as Construct, '');
    this.outdir = props.outdir ?? 'github.out';
  }

  /** Path the manifest is (or would be) written to. */
  get manifestPath(): string {
    return join(this.outdir, 'manifest.json');
  }

  /**
   * Walk the tree, build the desired state, and write it to
   * `<outdir>/manifest.json`. Returns the in-memory desired state too.
   */
  synth(): DesiredState {
    const state = synthesize(this);
    const path = this.manifestPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return state;
  }
}
