# Node runs the TypeScript as it is, so there is no build step. The programs it runs are given by nix/agent.nix, so
# that a change to one of them does not build this again.
{
  lib,
  buildNpmPackage,
  nodejs_26,
  playwright-driver,
}:
buildNpmPackage {
  pname = "agent-unwrapped";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src
      ../manual
    ];
  };
  nodejs = nodejs_26;
  npmDepsHash = "sha256-bvwqrl+sxX0ctC5wTawKbZ9aY5KaKWODuamqDEAVRmA=";
  dontNpmBuild = true;
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --no-save
    mkdir -p $out/lib/agent
    cp -r package.json src manual node_modules $out/lib/agent/
    # Not from npm: nixpkgs' own, so that it is always the Playwright of the nixpkgs the rest comes from.
    ln -s ${playwright-driver} $out/lib/agent/node_modules/playwright-core
    runHook postInstall
  '';
}
