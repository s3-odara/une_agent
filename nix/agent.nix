# Node runs the TypeScript as it is, so there is no build step.
{
  lib,
  buildNpmPackage,
  nodejs_26,
  makeWrapper,
  ffmpeg-headless,
  playwright-driver,
  gateway,
  whisper-server,
  stt-models,
}:
buildNpmPackage {
  pname = "agent";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../src
    ];
  };
  nodejs = nodejs_26;
  npmDepsHash = "sha256-iRMxu/K2OO121IU1f2dACcFhiRGdk9ry5HfDZE4Z2bY=";
  dontNpmBuild = true;
  nativeBuildInputs = [ makeWrapper ];
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --no-save
    mkdir -p $out/lib/agent $out/bin
    cp -r package.json src node_modules $out/lib/agent/
    for entry in agent:main.ts agent-browser-login:browser-login.ts agent-model-login:model-login.ts; do
      makeWrapper ${lib.getExe nodejs_26} $out/bin/''${entry%%:*} \
        --add-flags $out/lib/agent/src/''${entry#*:} \
        --set-default AGENT_GATEWAY_BIN ${lib.getExe gateway} \
        --set-default AGENT_WHISPER_SERVER ${lib.getExe whisper-server} \
        --set-default AGENT_STT_MODELS ${stt-models} \
        --set-default PLAYWRIGHT_BROWSERS_PATH ${playwright-driver.browsers} \
        --prefix PATH : ${lib.makeBinPath [ ffmpeg-headless ]}
    done
    runHook postInstall
  '';
  meta = {
    description = "A personal agent on Matrix";
    mainProgram = "agent";
  };
}
