{
  description = "A personal agent on Matrix: the Node agent, the Rust gateway, and their speech parts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    {
      self,
      nixpkgs,
      crane,
      ...
    }:
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
      sandbox = pkgs.callPackage ./nix/sandbox.nix { inherit craneLib; };
      whisper-server = pkgs.callPackage ./nix/whisper-server.nix { };
      stt-models = pkgs.callPackage ./nix/stt-models.nix { };
      # The headless shell stays: Playwright launches it for headless Chromium.
      playwright-browsers = pkgs.playwright-driver.browsers.override {
        withFirefox = false;
        withWebkit = false;
      };
      agent = pkgs.callPackage ./nix/agent.nix {
        inherit
          gateway
          sandbox
          whisper-server
          stt-models
          playwright-browsers
          ;
      };
      deployment = pkgs.callPackage ./nix/deployment.nix {
        inherit agent gateway;
        rev =
          self.rev
            or (throw "commit or stash the changes first, so that the installed build is a known commit");
      };
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
          sandbox
          whisper-server
          stt-models
          deployment
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
        PLAYWRIGHT_BROWSERS_PATH = playwright-browsers;
        # playwright-core is nixpkgs', not npm's (see nix/agent.nix); `npm install` takes the link away, entering the
        # shell again puts it back.
        shellHook = ''
          mkdir -p node_modules
          ln -sfn ${pkgs.playwright-driver} node_modules/playwright-core
        '';
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
