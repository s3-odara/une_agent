# whisper.cpp's server at the commit that was measured (HANDOFF.md, step 5), with Vulkan. Bump deliberately.
#
# The CPU code is built for several CPU generations and picked at start, so the build does not depend on the machine it
# ran on. The GPU is reached through nixpkgs' Mesa, whose AMD driver speaks virtio native context in a VM; set
# VK_ICD_FILENAMES to use another driver. The host's implicit Vulkan layers are left out: they are built against the
# host's libraries, not these.
{
  lib,
  stdenv,
  fetchFromGitHub,
  cmake,
  ninja,
  makeWrapper,
  shaderc,
  vulkan-headers,
  vulkan-loader,
  spirv-headers,
  mesa,
}:
stdenv.mkDerivation {
  pname = "whisper-server";
  version = "0-unstable-aba02de";
  src = fetchFromGitHub {
    owner = "ggml-org";
    repo = "whisper.cpp";
    rev = "aba02defd6bb6ff5de63721c21e3456645c153e2";
    hash = "sha256-8sDWTzUCkASwZLHVJH5zn55awYKSkJEsTN3ID7z/ZdY=";
  };
  nativeBuildInputs = [
    cmake
    ninja
    makeWrapper
    shaderc
  ];
  buildInputs = [
    vulkan-headers
    vulkan-loader
    spirv-headers
  ];
  cmakeFlags = [
    (lib.cmakeBool "GGML_VULKAN" true)
    (lib.cmakeBool "GGML_NATIVE" false)
    (lib.cmakeBool "GGML_BACKEND_DL" true)
    (lib.cmakeBool "GGML_CPU_ALL_VARIANTS" true)
    (lib.cmakeBool "WHISPER_BUILD_TESTS" false)
    (lib.cmakeBool "WHISPER_SDL2" false)
  ];
  postFixup = ''
    wrapProgram $out/bin/whisper-server \
      --set-default VK_ICD_FILENAMES "$(echo ${mesa}/share/vulkan/icd.d/*.json | tr ' ' :)" \
      --set-default VK_LOADER_LAYERS_DISABLE '~implicit~'
  '';
  meta = {
    description = "whisper.cpp's HTTP server, for the agent's speech recognition";
    license = lib.licenses.mit;
    mainProgram = "whisper-server";
  };
}
