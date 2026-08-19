#!/bin/sh
# install.sh — install the `abg dsh` shim and the `dsh` web+chrome wrapper
# so `abg dsh ...` routes to this adapter and bare `dsh` boots the GUI.
#
#   ./install.sh                 # install to ~/.bun/bin/{abg,dsh} (default)
#   ./install.sh /custom/bin/abg # install to a custom path (dsh goes next to it)
#
# The abg shim passes through every non-`dsh` command to the real abg on
# PATH, so agent-bridge's native commands keep working unchanged. The dsh
# wrapper passes through everything except bare `dsh` / `dsh web`, which
# boot the web GUI and open the chromium app window (no MCP — that stays
# with `abg dsh --pair NAME`).
set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ADAPTER="$SCRIPT_DIR/bin/abg-dsh"
DSH_WRAPPER="$SCRIPT_DIR/bin/dsh"
DEST="${1:-$HOME/.bun/bin/abg}"
DEST_DIR="$(dirname -- "$DEST")"
DSH_DEST="$DEST_DIR/dsh"

if [ ! -f "$ADAPTER" ]; then
  echo "error: $ADAPTER not found (run install.sh from the repo root)" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun not found on PATH (abg-dsh is a bun script)" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
sed "s|__ADAPTER_PATH__|$ADAPTER|g" "$SCRIPT_DIR/install.sh.template" > "$DEST"
chmod +x "$DEST"

if [ -f "$DSH_WRAPPER" ]; then
  cp "$DSH_WRAPPER" "$DSH_DEST"
  chmod +x "$DSH_DEST"
  echo "installed wrapper: $DSH_DEST -> web GUI + chromium (bare \`dsh\`)"
else
  echo "warning: $DSH_WRAPPER not found, skipping dsh wrapper install" >&2
fi

echo "installed shim: $DEST -> $ADAPTER"
echo "try: abg dsh --pair NAME   (or: abg --pair NAME dsh)"
echo "try: dsh                   (web GUI + chromium window)"
