# The development recipes need the dev shell (`nix develop`, or direnv with .envrc) for Node, Rust, ffmpeg, Radicale
# and the rest. The deployment recipes need only nix and systemd.

set shell := ["bash", "-euo", "pipefail", "-c"]

config := "config.json"
deployed := env("HOME") / ".config/agent"
state := env("XDG_STATE_HOME", env("HOME") / ".local/state") / "agent"
units := env("HOME") / ".config/systemd/user"

[private]
default:
    @just --list --unsorted

# Type-check, and run the tests of the agent and the gateway.
check: typecheck test test-gateway

typecheck:
    npx tsc --noEmit

# Run the agent's tests: all of them, or the files given.
test *files:
    node --test --test-timeout=60000 {{ if files == "" { "'test/**/*.test.ts'" } else { files } }}

test-gateway:
    cargo test --manifest-path gateway/Cargo.toml

# Run the CalDAV tests against a Radicale started for them.
test-caldav:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=$(mktemp -d)
    radicale --server-hosts 127.0.0.1:5232 --auth-type none --storage-filesystem-folder "$dir" &
    trap 'kill $!; rm -rf "$dir"' EXIT
    for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:5232/ && break; sleep 0.2; done
    CALDAV_TEST_URL=http://127.0.0.1:5232 node --test --test-timeout=60000 test/caldav.integration.test.ts

# Run the speech recognition tests on recordings (a.ogg:b.ogg) and, if given, their scripts (a.txt:b.txt).
test-stt audio text="":
    AGENT_WHISPER_SERVER=$(nix build --no-link --print-out-paths .#whisper-server)/bin/whisper-server \
    AGENT_STT_MODELS=$(nix build --no-link --print-out-paths .#stt-models) \
    STT_TEST_AUDIO={{ quote(audio) }} STT_TEST_TEXT={{ quote(text) }} \
    node --test --test-timeout=600000 test/stt.integration.test.ts

# Write test/protocol.json again from test/protocol.ts, after changing what the gateway and the agent exchange.
protocol:
    node -e 'import("./test/protocol.ts").then(m => process.stdout.write(JSON.stringify(m.protocolJson(), null, "\t") + "\n"))' > test/protocol.json

# Build the gateway from source, for `just run`.
gateway:
    cargo build --release --manifest-path gateway/Cargo.toml

# Run the agent from source on ./config.json, with the speech recognizer and its models built by nix.
run: gateway
    AGENT_WHISPER_SERVER=$(nix build --no-link --print-out-paths .#whisper-server)/bin/whisper-server \
    AGENT_STT_MODELS=$(nix build --no-link --print-out-paths .#stt-models) \
    node --env-file-if-exists=.env src/main.ts {{ config }}

# Log the gateway in for ./config.json (the password is asked for, or taken from MATRIX_PASSWORD).
login *args: gateway
    gateway/target/release/matrix-gateway login --config {{ config }} {{ args }}

# Open a browser window on the agent's profile to log in by hand (needs a display; stop the agent first).
browser-login url profile="default":
    AGENT_CONFIG={{ config }} node --env-file-if-exists=.env src/browser-login.ts {{ quote(url) }} {{ quote(profile) }}

# Log in to a subscription model provider (OpenAI Codex by default) and store it in the data directory's auth.json.
model-login provider="openai-codex":
    AGENT_CONFIG={{ config }} node src/model-login.ts {{ quote(provider) }}

# Show the GPUs the speech recognizer can use, through the same Vulkan driver it uses.
vulkan:
    nix run .#vulkan-check

# Once per machine: keep the services running without a login, and make ~/.config/agent from the examples.
setup:
    #!/usr/bin/env bash
    set -euo pipefail
    loginctl enable-linger "$USER"
    mkdir -p {{ deployed }}
    if [ ! -e {{ deployed }}/config.json ]; then
      cp config.example.json {{ deployed }}/config.json
      cp -r personas {{ deployed }}/
      echo "wrote {{ deployed }}/config.json: fill it in"
    fi
    if [ ! -e {{ deployed }}/env ]; then
      install -m 600 .env.example {{ deployed }}/env
      echo "wrote {{ deployed }}/env: put the secrets in it"
    fi

# Log the deployed gateway in (the password is asked for, or taken from MATRIX_PASSWORD).
deployed-login *args:
    cd {{ deployed }} && nix run {{ justfile_directory() }}#gateway -- login --config config.json {{ args }}

# Log the deployed agent in to a subscription model provider (OpenAI Codex by default) through a browser.
deployed-model-login provider="openai-codex":
    AGENT_CONFIG={{ deployed }}/config.json nix shell .#agent -c agent-model-login {{ quote(provider) }}

# Open a browser window on the deployed agent's profile to log in by hand (needs a display; stops the agent meanwhile).
deployed-browser-login url profile="default":
    systemctl --user stop agent.service
    AGENT_CONFIG={{ deployed }}/config.json nix shell .#agent -c agent-browser-login {{ quote(url) }} {{ quote(profile) }}
    systemctl --user start agent.service

# Build what is checked out and (re)start it as the deployed agent. Run again to update.
install:
    nix build .#units -o {{ state }}/units
    mkdir -p {{ units }}
    install -m 644 {{ state }}/units/*.service {{ units }}/
    systemctl --user daemon-reload
    systemctl --user enable agent.service
    systemctl --user restart agent.service

status:
    systemctl --user status agent.service voicevox.service

# Follow the logs of the agent (its gateway's included) and of VOICEVOX.
logs:
    journalctl --user -u agent.service -u voicevox.service -f

stop:
    systemctl --user stop agent.service voicevox.service

uninstall: stop
    systemctl --user disable agent.service
    rm -f {{ units }}/agent.service {{ units }}/voicevox.service
    systemctl --user daemon-reload
    rm -f {{ state }}/units
