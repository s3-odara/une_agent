"""Refresh the dependencies that can move independently of the Matrix call stack."""

import json
import re
import subprocess
import tomllib
from pathlib import Path

from pinned_dependencies import check_models, gh, stable_tag


def run(*args):
    subprocess.run(args, check=True)


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def update_npm():
    manifest = Path("package.json")
    package = json.loads(manifest.read_text())
    pi_version = output("npm", "view", "@earendil-works/pi-durable@latest", "version")
    for section in ("dependencies", "devDependencies"):
        for name in package[section]:
            package[section][name] = (
                pi_version if name.startswith("@earendil-works/")
                else output("npm", "view", f"{name}@latest", "version")
            )
    manifest.write_text(json.dumps(package, ensure_ascii=False, indent="\t") + "\n")
    run("npm", "update", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund")

    npm_hash = output("prefetch-npm-deps", "package-lock.json")
    if not re.fullmatch(r"sha256-[A-Za-z0-9+/]{43}=", npm_hash):
        raise SystemExit(f"Unexpected npmDepsHash: {npm_hash!r}")
    recipe = Path("nix/agent-unwrapped.nix")
    updated, count = re.subn(r'npmDepsHash = "[^"]+";', f'npmDepsHash = "{npm_hash}";', recipe.read_text())
    if count != 1:
        raise SystemExit("Expected exactly one npmDepsHash in nix/agent-unwrapped.nix")
    recipe.write_text(updated)


def locked_packages(manifest):
    return tomllib.loads(manifest.with_name("Cargo.lock").read_text())["package"]


def pinned_for_calls(package):
    return package.get("source", "").startswith("git+") or package["name"].startswith(
        ("matrix-", "ruma", "livekit", "libwebrtc", "webrtc-sys")
    )


def call_pins(packages):
    return {
        (p["name"], p["version"], p.get("source"), p.get("checksum"))
        for p in packages
        if pinned_for_calls(p)
    }


def update_cargo():
    gateway = Path("gateway/Cargo.toml")
    before = locked_packages(gateway)
    movable = sorted({
        f"{p['name']}@{p['version']}"
        for p in before
        if p.get("source", "").startswith("registry+") and not pinned_for_calls(p)
    })
    if movable:
        run("cargo", "update", "--manifest-path", str(gateway), *movable)
    if call_pins(before) != call_pins(locked_packages(gateway)):
        raise SystemExit("Cargo changed a Matrix call dependency; update the call stack by hand.")
    run("cargo", "update", "--manifest-path", "sandbox/Cargo.toml")


def update_whisper():
    path = Path("nix/whisper-server.nix")
    recipe = path.read_text()
    installed = re.search(r'rev = "([0-9a-f]{40})";', recipe)[1]
    repo = "ggml-org/whisper.cpp"
    latest = stable_tag(repo)
    api = f"repos/{repo}"
    release = gh("api", f"{api}/commits/{latest}")
    rev = release["sha"]
    if not re.fullmatch(r"[0-9a-f]{40}", rev):
        raise ValueError(f"Unexpected whisper.cpp revision: {rev!r}")
    if rev == installed:
        return

    status = gh("api", f"{api}/compare/{installed}...{rev}?per_page=1")["status"]
    if status == "diverged":
        current = gh("api", f"{api}/commits/{installed}")
        if release["commit"]["committer"]["date"] <= current["commit"]["committer"]["date"]:
            return
    elif status != "ahead":
        return

    digest = json.loads(output("nix", "flake", "prefetch", "--json", f"github:{repo}/{rev}"))["hash"]
    if not re.fullmatch(r"sha256-[A-Za-z0-9+/]{43}=", digest):
        raise ValueError(f"Unexpected whisper.cpp source hash: {digest!r}")
    for key, value in (("version", latest.removeprefix("v")), ("rev", rev), ("hash", digest)):
        recipe, count = re.subn(rf'\b{key} = "[^"]+";', f'{key} = "{value}";', recipe)
        if count != 1:
            raise ValueError(f"Expected exactly one {key} in {path}")
    path.write_text(recipe)
    print(f"whisper.cpp {installed[:12]} -> {latest}")


if __name__ == "__main__":
    update_npm()
    update_cargo()
    check_models(update=True)
    update_whisper()
