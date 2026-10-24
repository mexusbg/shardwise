#!/usr/bin/env bash
# Builds the macOS arm64 app as a .zip on Linux (dmg needs hdiutil, which exists only on macOS).
# Native addons are swapped for their macOS builds for the duration of the build, and the app is ad-hoc
# signed with rcodesign so Apple Silicon will run it (it is not notarized: see README → macOS).
set -euo pipefail
cd "$(dirname "$0")/.."

TOOLS="$HOME/build/tools"
mkdir -p "$TOOLS"
if [ ! -x "$TOOLS/rcodesign" ]; then
  url="$(curl -fsSL https://api.github.com/repos/indygreg/apple-platform-rs/releases \
    | grep -o 'https://[^"]*apple-codesign-[^"]*-x86_64-unknown-linux-musl.tar.gz' | head -1)"
  echo "Downloading $url"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" | tar -xz -C "$tmp"
  mv "$(find "$tmp" -name rcodesign -type f)" "$TOOLS/rcodesign"
  chmod +x "$TOOLS/rcodesign"
  rm -rf "$tmp"
fi
export RCODESIGN="$TOOLS/rcodesign"

# Linux builds of the native addons; restored when the script ends.
NATIVE=(node_modules/kerberos/build node_modules/ssh2/lib/protocol/crypto/build node_modules/cpu-features/build)
STASH="$(mktemp -d)"
restore() {
  for d in "${NATIVE[@]}"; do
    rm -rf "$d"
    [ -d "$STASH/$d" ] && mkdir -p "$(dirname "$d")" && mv "$STASH/$d" "$d"
  done
  rm -rf "$STASH"
}
trap restore EXIT
for d in "${NATIVE[@]}"; do
  [ -d "$d" ] && mkdir -p "$STASH/$(dirname "$d")" && mv "$d" "$STASH/$d"
done
# kerberos (GSSAPI auth) has N-API prebuilds; ssh2 and cpu-features fall back to JavaScript without theirs.
(cd node_modules/kerberos && npx --yes prebuild-install --runtime napi --platform darwin --arch arm64)
test -f node_modules/kerberos/build/Release/kerberos.node

node scripts/fetch-tools.mts mac-arm64
node scripts/notices.mjs
npx electron-vite build
npx electron-builder --publish never --mac dir --arm64 -c.afterPack=scripts/mac-adhoc-sign.cjs
# Zipped here, not by electron-builder, which would follow the framework symlinks.
VERSION="$(node -p "require('./package.json').version")"
rm -f release/"$VERSION"/*-mac-arm64.zip*
python3 -I scripts/zip-app.py release/"$VERSION"/mac-arm64/Shardwise.app release/"$VERSION"/Shardwise-"$VERSION"-mac-arm64.zip
