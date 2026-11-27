{
  lib,
  craneLib,
  libwebrtc,
  pkg-config,
  glib,
}:
let
  # libwebrtc is built against Chromium's libc++, which needs clang (21 or later).
  clangCrane = craneLib.overrideScope (
    _: _: {
      stdenvSelector = pkgs: pkgs.clangStdenv;
    }
  );
  src = lib.fileset.toSource {
    root = ../gateway;
    fileset = lib.fileset.unions [
      ../gateway/Cargo.toml
      ../gateway/Cargo.lock
      ../gateway/src
    ];
  };
  common = {
    inherit src;
    strictDeps = true;
    nativeBuildInputs = [ pkg-config ];
    # webrtc-sys compiles against glib's headers only.
    buildInputs = [ glib ];
    LK_CUSTOM_WEBRTC = libwebrtc;
  };
  cargoArtifacts = clangCrane.buildDepsOnly common;
in
clangCrane.buildPackage (
  common
  // {
    inherit cargoArtifacts;
    # The IPC tests read the agent's examples, which are outside the gateway's source; `just check` runs them.
    doCheck = false;
    meta.mainProgram = "matrix-gateway";
  }
)
