{
  description = "A personal agent on Matrix: the Node agent, the Rust gateway, and their speech parts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    { nixpkgs, crane, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        # VOICEVOX's runtime is free to use under its own terms, which nixpkgs counts as unfree. Nothing else is let in.
        config.allowUnfreePredicate = pkg: nixpkgs.lib.hasPrefix "voicevox" (nixpkgs.lib.getName pkg);
      };
      craneLib = crane.mkLib pkgs;
      libwebrtc = pkgs.callPackage ./nix/libwebrtc.nix { };
      gateway = pkgs.callPackage ./nix/gateway.nix { inherit craneLib libwebrtc; };
      whisper-server = pkgs.callPackage ./nix/whisper-server.nix { };
      stt-models = pkgs.callPackage ./nix/stt-models.nix { };
      agent = pkgs.callPackage ./nix/agent.nix { inherit gateway whisper-server stt-models; };
      units = pkgs.callPackage ./nix/units.nix { inherit agent; };
      # The GPUs as the speech recognizer sees them: through the same Vulkan driver (see nix/whisper-server.nix).
      vulkan-check = pkgs.writeShellApplication {
        name = "vulkan-check";
        runtimeInputs = [ pkgs.vulkan-tools ];
        text = ''
          VK_ICD_FILENAMES="''${VK_ICD_FILENAMES:-$(echo ${pkgs.mesa}/share/vulkan/icd.d/*.json | tr ' ' :)}"
          export VK_ICD_FILENAMES VK_LOADER_LAYERS_DISABLE="''${VK_LOADER_LAYERS_DISABLE:-~implicit~}"
          vulkaninfo --summary
        '';
      };
    in
    {
      packages.${system} = {
        inherit
          agent
          gateway
          whisper-server
          stt-models
          units
          vulkan-check
          ;
        inherit (pkgs) voicevox-engine;
        default = agent;
      };

      # clang's stdenv: the C++ that binds to libwebrtc needs clang (see nix/gateway.nix).
      devShells.${system}.default = pkgs.mkShell.override { stdenv = pkgs.clangStdenv; } {
        packages = with pkgs; [
          nodejs_26
          cargo
          rustc
          rustfmt
          clippy
          pkg-config
          glib
          ffmpeg-headless
          just
          curl
          radicale
          vulkan-tools
        ];
        LK_CUSTOM_WEBRTC = libwebrtc;
        PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
