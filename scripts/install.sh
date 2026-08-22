#!/bin/sh
set -eu

VERSION="${GITTYGO_VERSION:-0.1.0-alpha.2}"
REPOSITORY="${GITTYGO_REPOSITORY:-mohammadbashiri/gittygo}"
ARCHIVE_NAME="GittyGo-${VERSION}-arm64.zip"
RELEASE_BASE="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
INSTALL_APP="${GITTYGO_INSTALL_APP:-$HOME/Applications/GittyGo.app}"
BIN_DIRECTORY="${GITTYGO_BIN_DIR:-$HOME/.local/bin}"
DATA_DIRECTORY="${GITTYGO_INSTALL_DATA:-$HOME/.local/share/gittygo}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "GittyGo ${VERSION} currently supports Apple Silicon macOS only." >&2
  exit 1
fi

for command in curl shasum ditto mktemp; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

TEMPORARY="$(mktemp -d "${TMPDIR:-/tmp}/gittygo-install.XXXXXX")"
BACKUP_APP=""
cleanup() {
  rm -rf "$TEMPORARY"
  if [ -n "$BACKUP_APP" ] && [ -d "$BACKUP_APP" ] && [ -d "$INSTALL_APP" ]; then rm -rf "$BACKUP_APP"; fi
}
trap cleanup EXIT HUP INT TERM

ARCHIVE="$TEMPORARY/$ARCHIVE_NAME"
CHECKSUMS="$TEMPORARY/SHA256SUMS"
if [ -n "${GITTYGO_ARCHIVE:-}" ]; then
  cp "$GITTYGO_ARCHIVE" "$ARCHIVE"
  if [ -n "${GITTYGO_CHECKSUMS:-}" ]; then cp "$GITTYGO_CHECKSUMS" "$CHECKSUMS"; fi
else
  echo "Downloading GittyGo ${VERSION}..."
  curl -fL --retry 3 --proto '=https' --tlsv1.2 "$RELEASE_BASE/$ARCHIVE_NAME" -o "$ARCHIVE"
  curl -fL --retry 3 --proto '=https' --tlsv1.2 "$RELEASE_BASE/SHA256SUMS" -o "$CHECKSUMS"
fi

if [ -f "$CHECKSUMS" ]; then
  EXPECTED="$(awk -v name="$ARCHIVE_NAME" '$2 == name || $2 == "dist/" name { print $1; exit }' "$CHECKSUMS")"
  [ -n "$EXPECTED" ] || { echo "Checksum entry not found for $ARCHIVE_NAME." >&2; exit 1; }
  ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [ "$EXPECTED" = "$ACTUAL" ] || { echo "GittyGo archive checksum verification failed." >&2; exit 1; }
  echo "Checksum verified."
else
  echo "A checksum file is required." >&2
  exit 1
fi

EXTRACTED="$TEMPORARY/extracted"
mkdir -p "$EXTRACTED"
ditto -x -k "$ARCHIVE" "$EXTRACTED"
SOURCE_APP="$EXTRACTED/GittyGo.app"
[ -d "$SOURCE_APP" ] || { echo "The archive does not contain GittyGo.app." >&2; exit 1; }
[ -x "$SOURCE_APP/Contents/MacOS/GittyGo" ] || { echo "The GittyGo application is incomplete." >&2; exit 1; }

mkdir -p "$(dirname "$INSTALL_APP")" "$BIN_DIRECTORY" "$DATA_DIRECTORY"
STAGED_APP="${INSTALL_APP}.new.$$"
rm -rf "$STAGED_APP"
ditto "$SOURCE_APP" "$STAGED_APP"
if [ -e "$INSTALL_APP" ]; then
  BACKUP_APP="${INSTALL_APP}.old.$$"
  rm -rf "$BACKUP_APP"
  mv "$INSTALL_APP" "$BACKUP_APP"
fi
if ! mv "$STAGED_APP" "$INSTALL_APP"; then
  [ -n "$BACKUP_APP" ] && mv "$BACKUP_APP" "$INSTALL_APP"
  exit 1
fi

cp "$INSTALL_APP/Contents/Resources/bin/gittygo" "$BIN_DIRECTORY/gittygo.new.$$"
chmod 755 "$BIN_DIRECTORY/gittygo.new.$$"
mv "$BIN_DIRECTORY/gittygo.new.$$" "$BIN_DIRECTORY/gittygo"
cp "$INSTALL_APP/Contents/Resources/bin/gittygo-uninstall" "$BIN_DIRECTORY/gittygo-uninstall.new.$$"
chmod 755 "$BIN_DIRECTORY/gittygo-uninstall.new.$$"
mv "$BIN_DIRECTORY/gittygo-uninstall.new.$$" "$BIN_DIRECTORY/gittygo-uninstall"
printf '%s\n' "$VERSION" > "$DATA_DIRECTORY/version"

SKILL_SOURCE="$INSTALL_APP/Contents/Resources/skills/gittygo/SKILL.md"
install_skill() {
  agent_home="$1"
  [ -d "$agent_home" ] || return 0
  destination="$agent_home/skills/gittygo"
  mkdir -p "$destination"
  cp "$SKILL_SOURCE" "$destination/SKILL.md"
  echo "Installed agent skill: $destination/SKILL.md"
}
install_skill "${PI_AGENT_HOME:-$HOME/.pi/agent}"
install_skill "${CLAUDE_HOME:-$HOME/.claude}"
install_skill "${CODEX_HOME:-$HOME/.codex}"

case ":$PATH:" in
  *":$BIN_DIRECTORY:"*) ;;
  *)
    if [ "${GITTYGO_NO_PATH_UPDATE:-0}" != "1" ]; then
      PROFILE="${GITTYGO_SHELL_PROFILE:-$HOME/.zprofile}"
      PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
      touch "$PROFILE"
      if ! grep -F "$PATH_LINE" "$PROFILE" >/dev/null 2>&1; then
        printf '\n# GittyGo command\n%s\n' "$PATH_LINE" >> "$PROFILE"
        echo "Added ~/.local/bin to PATH in $PROFILE (applies to new shells)."
      fi
    fi
    ;;
esac

echo "Installed GittyGo ${VERSION} at $INSTALL_APP"
echo "CLI: $BIN_DIRECTORY/gittygo"
echo "No Apple verification or notarization is claimed for this build."
