# The Matrix gateway. Its git dependencies are pinned by Cargo.lock; libwebrtc comes from ./libwebrtc.nix.
{
  lib,
  craneLib,
  libwebrtc,
  pkg-config,
  glib,
}:
let
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
    # libwebrtc is built against Chromium's libc++, which needs clang (21 or later) for the C++ that binds to it.
    stdenv = p: p.clangStdenv;
    nativeBuildInputs = [ pkg-config ];
    # webrtc-sys compiles against glib's headers only.
    buildInputs = [ glib ];
    LK_CUSTOM_WEBRTC = libwebrtc;
  };
  cargoArtifacts = craneLib.buildDepsOnly common;
in
craneLib.buildPackage (
  common
  // {
    inherit cargoArtifacts;
    # The IPC tests read the agent's examples, which are outside the gateway's source; `just check` runs them.
    doCheck = false;
    meta.mainProgram = "matrix-gateway";
  }
)
