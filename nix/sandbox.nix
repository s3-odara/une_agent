{
  lib,
  craneLib,
}:
craneLib.buildPackage {
  src = lib.fileset.toSource {
    root = ../sandbox;
    fileset = lib.fileset.unions [
      ../sandbox/Cargo.toml
      ../sandbox/Cargo.lock
      ../sandbox/src
    ];
  };
  strictDeps = true;
  meta.mainProgram = "agent-sandbox";
}
