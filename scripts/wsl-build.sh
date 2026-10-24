#!/usr/bin/env bash
# Builds the Linux (AppImage + deb) and/or macOS (arm64) packages from Windows via WSL.
#   wsl.exe -d Ubuntu-22.04 -- bash scripts/wsl-build.sh [linux] [mac] [e2e]   (e2e: smoke test of the Linux build)
# The project is copied to the Linux file system (fast, real permissions); finished packages are copied back
# into release/<version>/ of the Windows checkout.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/build/shardwise}"
TARGETS="${*:-linux mac}"

source "$HOME/.nvm/nvm.sh"
nvm install 24 >/dev/null
nvm use 24 >/dev/null

mkdir -p "$WORK"
rsync -a --delete \
  --exclude node_modules --exclude out --exclude release --exclude .e2e --exclude 'resources/tools' \
  --exclude '*.uri' --exclude '*onnection*xport*' --exclude '*-connections.json' --exclude '*-connections.txt' \
  "$SRC/" "$WORK/"
cd "$WORK"

# Reinstall only when the lock file changed. `npm install`, not `ci`: a lock file written on Windows can miss
# optional dependencies that npm wants on Linux; the copy's lock file may change, the Windows one never does.
if ! cmp -s package-lock.json node_modules/.package-lock.json.src 2>/dev/null; then
  cp package-lock.json /tmp/shardwise-lock.src
  npm install --no-audit --no-fund
  mkdir -p node_modules && mv /tmp/shardwise-lock.src node_modules/.package-lock.json.src
fi

VERSION="$(node -p "require('./package.json').version")"
OUT="$SRC/release/$VERSION"
mkdir -p "$OUT"

for t in $TARGETS; do
  case "$t" in
    linux)
      if [ -n "$(node -p "require('./package.json').homepage || ''")" ]; then
        npm run dist:linux
        cp -f release/"$VERSION"/*.deb "$OUT/"
      else
        # The .deb control file requires a homepage; build only the AppImage until package.json has one.
        echo "No homepage in package.json: skipping the .deb"
        node scripts/fetch-tools.mts linux-x64 && node scripts/notices.mjs && npx electron-vite build
        npx electron-builder --linux AppImage --x64
      fi
      cp -f release/"$VERSION"/*.AppImage "$OUT/"
      ;;
    mac)
      bash scripts/mac-from-linux.sh
      cp -f release/"$VERSION"/*-mac-arm64.* "$OUT/"
      ;;
    e2e)
      # Smoke test of the packaged Linux app under a virtual display; screenshots go to .e2e/linux-screens.
      # --disable-gpu: SwiftShader under Xvfb draws stray diagonal lines across rounded boxes.
      E2E_EXE="$WORK/release/$VERSION/linux-unpacked/shardwise" E2E_ARGS="--no-sandbox --disable-gpu" \
        xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/e2e-smoke.mjs "$SRC/.e2e/linux-screens"
      ;;
    *) echo "unknown target $t" >&2; exit 1 ;;
  esac
done
ls -la "$OUT"
