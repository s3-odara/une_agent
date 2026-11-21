# The agent's commands, with the programs it runs. Only these scripts are made again when one of them changes.
{
  lib,
  runCommand,
  makeWrapper,
  nodejs_26,
  ffmpeg-headless,
  chromium,
  poppler-utils,
  fontConfig,
  agent-unwrapped,
  gateway,
  sandbox,
  whisper-server,
  stt-models,
}:
runCommand "agent-0.1.0"
  {
    nativeBuildInputs = [ makeWrapper ];
    passthru.unwrapped = agent-unwrapped;
    meta = {
      description = "A personal agent on Matrix";
      mainProgram = "agent";
    };
  }
  ''
    mkdir -p $out/bin
    for entry in agent:main.ts agent-model-login:model-login.ts; do
      makeWrapper ${lib.getExe nodejs_26} $out/bin/''${entry%%:*} \
        --add-flags ${agent-unwrapped}/lib/agent/src/''${entry#*:} \
        --set-default AGENT_GATEWAY_BIN ${lib.getExe gateway} \
        --set-default AGENT_SANDBOX_BIN ${lib.getExe sandbox} \
        --set-default AGENT_WHISPER_SERVER ${lib.getExe whisper-server} \
        --set-default AGENT_STT_MODELS ${stt-models} \
        --set-default AGENT_POPPLER_BIN ${poppler-utils}/bin \
        --set-default AGENT_PDF_FONTCONFIG ${fontConfig} \
        --set-default AGENT_CHROMIUM ${lib.getExe chromium} \
        --set-default AGENT_CHROMIUM_FONTCONFIG ${fontConfig} \
        --prefix PATH : ${lib.makeBinPath [ ffmpeg-headless ]}
    done
  ''
