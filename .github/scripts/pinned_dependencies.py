import hashlib
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path
from urllib.request import urlopen


def version(text):
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", text)
    return tuple(map(int, match.groups())) if match else ()


def gh(*args):
    return json.loads(subprocess.check_output(["gh", *args], text=True))


def download(url):
    with urlopen(url, timeout=20) as response:
        return response.read().decode()


def stable_tag(repo):
    refs = subprocess.check_output(
        ["git", "ls-remote", "--tags", "--refs", f"https://github.com/{repo}.git"], text=True
    )
    tags = (line.split("refs/tags/", 1)[1] for line in refs.splitlines())
    return max((tag for tag in tags if version(tag)), key=version)


def matrix_rtc_updates():
    manifest = Path("gateway/Cargo.toml")
    installed = tomllib.loads(manifest.read_text())["dependencies"]["matrix-rtc-call-sdk"]["tag"]
    rtc = "element-hq/matrix-rust-rtc"
    latest = stable_tag(rtc)
    if version(latest) > version(installed):
        yield f"[`matrix-rust-rtc {latest}`](https://github.com/{rtc}/releases/tag/{latest})（現在: {installed}）"


def check_models(*, update=False):
    path = Path("nix/stt-models.nix")
    recipe = path.read_text()
    pins = re.compile(
        r'url = "https://huggingface.co/([\w./-]+)/resolve/([0-9a-f]{40})/([\w.-]+)";\s+sha256 = "([0-9a-f]{64})";'
    )
    families = {
        "ggerganov/whisper.cpp": r"ggml-large-v(\d+)-turbo-q8_0\.bin",
        "ggml-org/whisper-vad": r"ggml-silero-v(\d+)\.(\d+)\.(\d+)\.bin",
    }

    def replace(pin):
        repo, ref, filename, pinned_hash = pin.groups()
        pattern = families[repo]
        installed = re.fullmatch(pattern, filename)
        if not installed:
            raise ValueError(f"Unexpected model filename: {filename}")
        current = tuple(map(int, installed.groups()))
        api = f"https://huggingface.co/api/models/{repo}"
        # Read candidates at the exact revision we will pin, even if main moves during this run.
        head = json.loads(download(f"{api}/revision/main"))["sha"] if update else "main"
        if update and not re.fullmatch(r"[0-9a-f]{40}", head):
            raise ValueError(f"Unexpected model repository revision: {head!r}")
        files = {
            file["path"]: file.get("lfs", {}).get("oid", "")
            for file in json.loads(download(f"{api}/tree/{head}?limit=100"))
        }
        url = f"https://huggingface.co/{repo}/blob/main/{filename}"
        actual_hash = files.get(filename)
        if not actual_hash:
            alerts.append(f"[`{filename}`]({url}) の配布ハッシュを確認できません（固定: `{pinned_hash}`）")
        elif actual_hash != pinned_hash:
            alerts.append(f"[`{filename}`]({url}) の配布ハッシュが変更: `{pinned_hash}` → `{actual_hash}`")
        elif update:
            candidates = [
                (tuple(map(int, match.groups())), name, digest)
                for name, digest in files.items()
                if (match := re.fullmatch(pattern, name)) and re.fullmatch(r"[0-9a-f]{64}", digest)
            ]
            latest, name, digest = max(candidates)
            if latest > current:
                print(f"{filename} -> {name}")
                return pin[0].replace(f'/resolve/{ref}/{filename}"', f'/resolve/{head}/{name}"').replace(pinned_hash, digest)
        return pin[0]

    alerts = []
    updated, count = pins.subn(replace, recipe)
    if count != len(families):
        raise ValueError("Expected a Whisper model and a VAD model in nix/stt-models.nix")
    if updated != recipe:
        path.write_text(updated)
    return alerts


def notify(title, changes, note, dry_run):
    if not changes:
        return
    fingerprint = hashlib.sha256("\n".join(changes).encode()).hexdigest()[:12]
    title = f"{title} [{fingerprint}]"
    body = "\n".join(f"- {change}" for change in changes) + f"\n\n{note}"
    if dry_run:
        print(f"{title}\n{body}\n")
    elif not any(issue["title"] == title for issue in gh(
        "issue", "list", "--state", "all", "--search", f'"{fingerprint}" in:title', "--json", "title"
    )):
        subprocess.run(["gh", "issue", "create", "--title", title, "--body", body], check=True)


if __name__ == "__main__":
    checks = (
        ("matrix-rust-rtc の更新候補", matrix_rtc_updates, "Matrix SDK・LiveKit・libwebrtc は上流に合わせて手動で揃え、暗号化ルームで双方向の音声を確認してください。"),
        ("音声認識モデルの配布ファイルを確認する", check_models, "現在のファイルのハッシュは自動では変更しません。"),
    )
    failed = False
    for title, check, note in checks:
        try:
            notify(title, list(check()), note, "--dry-run" in sys.argv[1:])
        except (ValueError, OSError, KeyError, TypeError, IndexError, subprocess.SubprocessError) as error:
            print(f"::error::{title}: {error}", file=sys.stderr)
            failed = True
    sys.exit(int(failed))
