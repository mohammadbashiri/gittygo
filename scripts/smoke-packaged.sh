#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ARCHIVE="${1:-$ROOT/dist/GittyGo-0.1.0-alpha.1-arm64.zip}"
CHECKSUMS="${2:-$ROOT/dist/SHA256SUMS}"
TEST_HOME="$(mktemp -d "${TMPDIR:-/tmp}/gittygo-smoke-home.XXXXXX")"
REPO="$TEST_HOME/repository"
APP="$TEST_HOME/Applications/GittyGo.app"
CLI="$TEST_HOME/.local/bin/gittygo"

cleanup() {
  pkill -f "$APP/Contents/MacOS/GittyGo" 2>/dev/null || true
  rm -rf "$TEST_HOME"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$REPO" "$TEST_HOME/.pi/agent/skills"
git -C "$REPO" init -q
git -C "$REPO" config user.name "GittyGo Smoke Test"
git -C "$REPO" config user.email "smoke@example.com"
printf 'initial\n' > "$REPO/file.txt"
git -C "$REPO" add .
git -C "$REPO" commit -qm initial

HOME="$TEST_HOME" GITTYGO_NO_PATH_UPDATE=1 GITTYGO_ARCHIVE="$ARCHIVE" GITTYGO_CHECKSUMS="$CHECKSUMS" "$ROOT/scripts/install.sh" >/dev/null
[ -x "$CLI" ]
[ -f "$TEST_HOME/.pi/agent/skills/gittygo/SKILL.md" ]
HOME="$TEST_HOME" "$CLI" instructions | node -e "JSON.parse(require('node:fs').readFileSync(0, 'utf8'))"
HOME="$TEST_HOME" "$CLI" open "$REPO" --json > "$TEST_HOME/open.json"
SESSION_ID="$(node -e "console.log(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).sessionId)" "$TEST_HOME/open.json")"
[ -n "$SESSION_ID" ]
HOME="$TEST_HOME" "$CLI" context --session "$SESSION_ID" --after 0 --json > "$TEST_HOME/context.json"
printf 'external\n' >> "$REPO/file.txt"
HOME="$TEST_HOME" "$CLI" context --session "$SESSION_ID" --after 0 --json > "$TEST_HOME/changed.json"
node -e "const x=JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); if(!x.externalStateChanged || x.snapshot.unstaged.length !== 1) process.exit(1)" "$TEST_HOME/changed.json"
HOME="$TEST_HOME" "$CLI" review show --session "$SESSION_ID" --json | node -e "const x=JSON.parse(require('node:fs').readFileSync(0, 'utf8')); if(x.openCommentCount !== 0) process.exit(1)"
HOME="$TEST_HOME" "$CLI" commit-message set --session "$SESSION_ID" --message "Smoke test" --json >/dev/null
HOME="$TEST_HOME" "$CLI" commit-message clear --session "$SESSION_ID" --json >/dev/null
HOME="$TEST_HOME" "$TEST_HOME/.local/bin/gittygo-uninstall" >/dev/null
[ ! -e "$APP" ]
[ -d "$TEST_HOME/.gittygo" ]

echo "Packaged GittyGo smoke test passed."
