{
  pkgs,
  inputs,
  ...
}: let
  # treefmt-nix owns the formatter config in Nix — it generates a biome.json
  # from `settings` and invokes Biome with it, so this is the single source of
  # truth (there is no hand-written biome.json to drift from). Biome is the
  # JS/TS/JSON formatter; the rules below favor single quotes and 2-space indent.
  treefmt = inputs.treefmt-nix.lib.evalModule pkgs {
    projectRootFile = "devenv.nix";
    settings.global.excludes = ["github.out/*" "*.lock"];
    programs.biome = {
      enable = true;
      formatCommand = "format"; # format only (quotes/indent), not lint
      settings = {
        formatter = {
          enabled = true;
          indentStyle = "space";
          indentWidth = 2;
          lineWidth = 80;
        };
        javascript.formatter = {
          quoteStyle = "single";
          jsxQuoteStyle = "single";
        };
      };
    };
  };
  treefmtWrapper = treefmt.config.build.wrapper;
in {
  # cdkgithub is a TypeScript project run on Bun (package manager + runtime +
  # test runner). One shell provides Bun plus the GitHub CLI, which the tool
  # falls back to for a token (`gh auth token`) when GITHUB_TOKEN is unset.
  packages = [
    pkgs.gh
    pkgs.git
    treefmtWrapper # `treefmt` — Biome-backed formatter (config via treefmt-nix)
  ];

  languages.javascript = {
    enable = true;
    bun = {
      enable = true;
      # Run `bun install` on shell entry and when the lockfile changes.
      install.enable = true;
    };
  };

  # Shorthands mirroring the package.json scripts.
  scripts.synth.exec = "bun src/bin/cdkgithub.ts synth examples/factbird.ts";
  scripts.synth-workflows.exec = "bun run synth:workflows";
  # Format via treefmt (Biome under the hood). `fmt` rewrites in place; `lint`
  # is check-only and fails on any diff (what CI/`devenv test` runs).
  scripts.fmt.exec = "treefmt";
  scripts.lint.exec = "treefmt --ci";

  enterShell = ''
    echo "cdkgithub dev shell — bun $(bun --version)"
  '';

  # `devenv test` gates the same things CI does (formatting + typecheck + tests).
  enterTest = ''
    treefmt --ci
    bun run build
    bun test
  '';
}
