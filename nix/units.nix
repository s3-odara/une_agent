# systemd user units for a machine that is not NixOS: `just install` copies them to ~/.config/systemd/user.
#
# The agent reads ~/.config/agent/config.json (paths in it are relative to that directory) and the secrets in
# ~/.config/agent/env (ANTHROPIC_API_KEY=..., CALDAV_PASSWORD=...). Its data goes where the config's `dataDir` says.
{
  lib,
  writeTextDir,
  symlinkJoin,
  agent,
  voicevox-engine,
}:
symlinkJoin {
  name = "agent-units";
  paths = [
    (writeTextDir "agent.service" ''
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
      RestartSec=10

      [Install]
      WantedBy=default.target
    '')
    (writeTextDir "voicevox.service" ''
      [Unit]
      Description=VOICEVOX Engine for the agent's voice

      [Service]
      ExecStart=${lib.getExe voicevox-engine} --host 127.0.0.1 --port 50021
      Restart=on-failure
      RestartSec=10
    '')
  ];
}
