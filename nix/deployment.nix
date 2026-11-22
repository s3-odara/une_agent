# systemd user units rather than a NixOS module, for a machine that is not NixOS.
# The commands come along so that the login recipes run the same build as the service, not what is checked out.
{
  lib,
  runCommand,
  writeText,
  agent,
  gateway,
  voicevox-engine,
  rev,
}:
let
  agentService = writeText "agent.service" ''
    [Unit]
    Description=Personal agent on Matrix
    Wants=network-online.target voicevox.service
    After=network-online.target voicevox.service

    [Service]
    WorkingDirectory=%h/.config/agent
    EnvironmentFile=-%h/.config/agent/env
    ExecStart=${lib.getExe agent} %h/.config/agent/config.json
    # The agent stops when its gateway does; both start again together.
    Restart=on-failure
    # agent_restart: the agent exits with this to be started again on its changed config.
    RestartForceExitStatus=75
    RestartSec=10

    [Install]
    WantedBy=default.target
  '';
  voicevoxService = writeText "voicevox.service" ''
    [Unit]
    Description=VOICEVOX Engine for the agent's voice

    [Service]
    ExecStart=${lib.getExe voicevox-engine} --host 127.0.0.1 --port 50021
    Restart=on-failure
    RestartSec=10
  '';
in
# Not symlinkJoin: it would mirror the agent's node_modules (some 15,000 links) into a new path on every commit.
runCommand "agent-deployment" { } ''
  mkdir -p $out/bin $out/share/systemd/user
  ln -s ${agent}/bin/* ${gateway}/bin/* $out/bin/
  ln -s ${agentService} $out/share/systemd/user/agent.service
  ln -s ${voicevoxService} $out/share/systemd/user/voicevox.service
  echo ${rev} > $out/rev
''
