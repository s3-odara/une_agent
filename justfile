# The development recipes need the dev shell (`nix develop`, or direnv with .envrc) for Node, Rust, ffmpeg, Radicale
# and the rest. The deployment recipes need only nix and systemd.

set shell := ["bash", "-euo", "pipefail", "-c"]

deployed := env("HOME") / ".config/agent"
state := env("XDG_STATE_HOME", env("HOME") / ".local/state") / "agent"
units := env("HOME") / ".config/systemd/user"
current := state / "current"

[private]
default:
    @just --list --unsorted

# Type-check, and run the tests of the agent and the gateway.
check: typecheck test test-gateway

typecheck:
    npx tsc --noEmit

# Run the agent's tests: all of them, or the files given.
test *files: sandbox
    node --test --test-timeout=60000 {{ if files == "" { "'test/**/*.test.ts'" } else { files } }}

test-gateway:
    cargo test --manifest-path gateway/Cargo.toml

# Typecheck and simulate the formal Quint models under spec/.
spec:
    quint typecheck spec/delivery.qnt
    quint typecheck spec/proactive.qnt
    quint typecheck spec/call.qnt
    quint typecheck spec/approval.qnt
    quint run spec/delivery.qnt --max-samples=5000 --max-steps=25 --invariant=allInvariants --verbosity=1
    quint run spec/proactive.qnt --max-samples=5000 --max-steps=25 --invariant=allInvariants --verbosity=1
    quint run spec/call.qnt --max-samples=5000 --max-steps=25 --invariant=allInvariants --verbosity=1
    quint run spec/approval.qnt --max-samples=5000 --max-steps=25 --invariant=allInvariants --verbosity=1

# Run bounded model checking (Apalache) on the Quint models.
verify steps="8":
    quint verify spec/delivery.qnt --max-steps={{ steps }} --invariant=allInvariants --verbosity=1
    quint verify spec/proactive.qnt --max-steps={{ steps }} --invariant=allInvariants --verbosity=1
    quint verify spec/call.qnt --max-steps={{ steps }} --invariant=allInvariants --verbosity=1
    quint verify spec/approval.qnt --max-steps={{ steps }} --invariant=allInvariants --verbosity=1

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

# Build the browser's sandbox from source for the tests.
sandbox:
    cargo build --release --manifest-path sandbox/Cargo.toml

# Build the geocoding database from the downloaded national datasets.
geocode-db sources="data/geocode-sources" output="data/geocode.sqlite":
    nix shell --inputs-from . nixpkgs#python3 nixpkgs#osmium-tool --command \
      python3 scripts/build-geocode.py \
        --offices {{ quote(sources) }}/P05-22_GML.zip \
        --towns {{ quote(sources) }}/isj/*.zip \
        --osm {{ quote(sources) }}/japan-latest.osm.pbf \
        --output {{ quote(output) }}

# Show the GPUs the speech recognizer can use, through the same Vulkan driver it uses.
vulkan:
    nix run .#vulkan-check

# Let Chromium from the Nix store make its sandbox where Ubuntu restricts user namespaces (asks for sudo).
apparmor:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" != 1 ]; then
      echo "user namespaces are not restricted here: nothing to do"
      exit 0
    fi
    sudo install -m 644 apparmor/agent-chromium /etc/apparmor.d/agent-chromium
    sudo apparmor_parser -r /etc/apparmor.d/agent-chromium

# Once per machine: keep the services running without a login, allow Chromium's sandbox, and make ~/.config/agent.
setup: apparmor
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
login *args:
    cd {{ deployed }} && {{ current }}/bin/matrix-gateway login --config config.json {{ args }}

# Log in to an OAuth provider (OpenAI Codex by default) and save it in the deployed agent's auth.json.
model-login provider="openai-codex":
    AGENT_CONFIG={{ deployed }}/config.json {{ current }}/bin/agent-model-login {{ quote(provider) }}

# Build the checked-out commit and (re)start it as the deployed agent. Run again to update.
install:
    nix build .#deployment -o {{ current }}
    mkdir -p {{ units }}
    install -m 644 {{ current }}/share/systemd/user/*.service {{ units }}/
    systemctl --user daemon-reload
    systemctl --user enable agent.service
    systemctl --user restart agent.service

status:
    @echo "installed: $(cat {{ current }}/rev)"
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
    rm -f {{ current }}
