{pkgs, ...}: {
  # cdkgithub is a TypeScript project run on Bun (package manager + runtime +
  # test runner). One shell provides Bun plus the GitHub CLI, which the tool
  # falls back to for a token (`gh auth token`) when GITHUB_TOKEN is unset.
  packages = [
    pkgs.gh
    pkgs.git
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
  scripts.synth.exec = "bun bin/cdkgithub.ts synth examples/factbird.ts";
  scripts.synth-workflows.exec = "bun run synth:workflows";

  enterShell = ''
    echo "cdkgithub dev shell — bun $(bun --version)"
  '';

  # `devenv test` gates the same things CI does (typecheck + unit tests).
  enterTest = ''
    bun run build
    bun test
  '';
}
