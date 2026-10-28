#!/bin/bash
# makes the macOS disk image players get: dist/Meadow-macos.dmg, Meadow beside a
# shortcut to Applications to drag it onto. run it on a Mac (BUILDING.md).
#
#   tools/build-mac.sh [--server https://game.playmeadow.xyz] [--flash /path/to/PepperFlashPlayer.plugin]
#
# first run 2026-10-16, in a macOS VM.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
version=11.5.0
server="https://game.playmeadow.xyz"  # --server for another (http://127.0.0.1:8080 to try a build here)
flash=$here/flash/PepperFlashPlayer.plugin
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift 2 ;;
    --flash) flash=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -d "$flash" ] || { echo "no flash plugin at $flash (BUILDING.md says where to get it)" >&2; exit 1; }

dist=$here/dist

# what the download page says each installer is: a line each in dist/RELEASES
# ("Meadow-Setup.exe 1.0.0 2026-10-27"), sent up with the installers
note_release() {
  local list=$dist/RELEASES
  { awk -v file="$1" '$1 != file' "$list" 2>/dev/null || true; echo "$1 $2 $(date -u +%F)"; } > "$list.new"
  mv "$list.new" "$list"
}
work=$(mktemp -d)
mkdir -p "$dist"
cd "$work"

base=https://github.com/electron/electron/releases/download/v$version
zip=electron-v$version-darwin-x64.zip
curl -fLO "$base/$zip"
curl -fLO "$base/SHASUMS256.txt"
grep " \*$zip\$" SHASUMS256.txt | shasum -a 256 -c -

# ditto keeps the symlinks inside the frameworks, which unzip may not
ditto -x -k "$zip" .
mv Electron.app Meadow.app
res=Meadow.app/Contents/Resources
rm -f "$res/default_app.asar"
cp -R "$here/app" "$res/app"
mkdir "$res/flash"
cp -R "$flash" "$res/flash/PepperFlashPlayer.plugin"
if [ -n "$server" ]; then
  printf '{"server": "%s"}\n' "$server" > "$res/app/build.json"
fi

plist=Meadow.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleName Meadow" -c "Set :CFBundleDisplayName Meadow" -c "Set :CFBundleIdentifier software.meadow.client" "$plist"
# meadow:// links (the account page's "Sign in with the Meadow client"):
# macOS takes only those the app names here.
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" -c "Add :CFBundleURLTypes:0 dict" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLName string Meadow" -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
  -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string meadow" "$plist"

mkdir icon.iconset
for size in 16 32 128 256; do
  sips -z $size $size "$here/app/icon.png" --out icon.iconset/icon_${size}x${size}.png >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$here/app/icon.png" --out icon.iconset/icon_${size}x${size}@2x.png >/dev/null
done
iconutil -c icns icon.iconset -o "$res/electron.icns"

# unsigned by a developer; an ad-hoc signature at least keeps the bundle whole
codesign --force --deep --sign - Meadow.app

mkdir image
mv Meadow.app image/
ln -s /Applications image/Applications
rm -f "$dist/Meadow-macos.dmg"
hdiutil create -volname Meadow -srcfolder image -ov -format UDZO "$dist/Meadow-macos.dmg"
shasum -a 256 "$dist/Meadow-macos.dmg"
note_release Meadow-macos.dmg "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/app/package.json")"
