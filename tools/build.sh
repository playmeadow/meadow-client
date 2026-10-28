#!/usr/bin/env bash
# makes the installers players get, into dist/:
#   Meadow-Setup.exe (windows), Meadow-x86_64.AppImage, meadow_amd64.deb, meadow.x86_64.rpm (linux)
#
#   tools/build.sh [--server https://game.playmeadow.xyz] [linux] [windows]
#
# needs electron/, electron-win/ and flash/ beside app/, tools/bin/rcedit-x64.exe,
# installer/node_modules (npm install in installer/) and rpmbuild (BUILDING.md).
# the windows wizard is installer/meadow.nsi; the linux packages, installer/builder.config.js.
# the macOS one is tools/build-mac.sh, run on a Mac.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
server="https://game.playmeadow.xyz"  # --server for another (http://127.0.0.1:8080 to try a build here)
targets=()
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift 2 ;;
    linux|windows) targets+=("$1"); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(linux windows)
if [ -n "$server" ] && ! [[ $server =~ ^https?://[^[:space:]]+$ ]]; then
  echo "--server wants an http(s) address" >&2
  exit 2
fi

need() {
  [ -e "$1" ] || { echo "missing $1 (BUILDING.md)" >&2; exit 1; }
}
need "$here/installer/node_modules/.bin/electron-builder"

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/app/package.json")
dist=$here/dist
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$dist"

# what the download page says each installer is: a line each in dist/RELEASES
# ("Meadow-Setup.exe 1.0.0 2026-10-27"), sent up with the installers
note_release() {
  local list=$dist/RELEASES
  { awk -v file="$1" '$1 != file' "$list" 2>/dev/null || true; echo "$1 $2 $(date -u +%F)"; } > "$list.new"
  mv "$list.new" "$list"
}

# the app as players get it, with the server's address
cp -r "$here/app" "$work/app"
if [ -n "$server" ]; then
  printf '{"server": "%s"}\n' "$server" > "$work/app/build.json"
fi

# electron.exe gets the logo and the name Meadow before electron-builder
# renames it. rcedit is a windows program: run through wsl, or wine elsewhere.
stamp() {
  local rcedit=$here/tools/bin/rcedit-x64.exe exe=$1 ico=$here/tools/icon.ico
  need "$rcedit"
  local run=("$rcedit")
  if grep -qi microsoft /proc/version 2>/dev/null; then
    exe=$(wslpath -w "$exe")
    ico=$(wslpath -w "$ico")
  elif command -v wine >/dev/null; then
    run=(wine "$rcedit")
  else
    echo "setting Meadow.exe's icon needs WSL or wine" >&2
    exit 1
  fi
  "${run[@]}" "$exe" --set-icon "$ico" --set-file-version "$version" --set-product-version "$version" \
    --set-version-string ProductName Meadow --set-version-string FileDescription Meadow \
    --set-version-string InternalName Meadow --set-version-string OriginalFilename Meadow.exe \
    --set-version-string CompanyName Meadow --set-version-string LegalCopyright ""
}

# electron-builder makes the linux packages
builder() {
  (cd "$here/installer" && BURROW_APP="$work/app" BURROW_OUT="$work/out" BURROW_ELECTRON="$1" BURROW_HOMEPAGE="$server" \
    npx --no-install electron-builder --config builder.config.js "${@:2}")
}

for target in "${targets[@]}"; do
  case "$target" in
    windows)
      need "$here/electron-win/electron.exe"
      need "$here/flash/pepflashplayer.dll"
      win=$work/windows
      cp -r "$here/electron-win" "$win"
      rm -f "$win/resources/default_app.asar"
      cp -r "$work/app" "$win/resources/app"
      mkdir -p "$win/resources/flash"
      cp "$here/flash/pepflashplayer.dll" "$win/resources/flash/"
      mv "$win/electron.exe" "$win/Meadow.exe"
      stamp "$win/Meadow.exe"
      # what the uninstaller takes away: the files and folders put there, by name
      (cd "$win" && for name in *; do
        if [ -d "$name" ]; then printf 'RMDir /r "$INSTDIR\\%s"\n' "$name"; else printf 'Delete "$INSTDIR\\%s"\n' "$name"; fi
      done) > "$work/files.nsh"
      # electron-builder's own copy of the nsis compiler, fetched and checked by it
      nsis=$(cd "$here/installer" && node -e 'require("app-builder-lib/out/toolsets/windows.js").getMakeNsisPath().then(r => console.log(r.path))')
      NSISDIR=$(dirname "$(dirname "$nsis")") "$nsis" -V2 -DVERSION="$version" -DSOURCE="$win" -DOUTFILE="$dist/Meadow-Setup.exe" \
        -DICON="$here/tools/icon.ico" -DFILES="$work/files.nsh" "$here/installer/meadow.nsi"
      note_release Meadow-Setup.exe "$version"
      ;;
    linux)
      need "$here/electron/electron"
      need "$here/flash/libpepflashplayer.so"
      command -v rpmbuild >/dev/null || { echo "missing rpmbuild (sudo pacman -S rpm-tools)" >&2; exit 1; }
      cp -r "$here/electron" "$work/electron"
      chmod 755 "$work/electron/electron" "$work/electron/chrome-sandbox"
      builder "$work/electron" --linux --x64
      cp "$work/out/Meadow-x86_64.AppImage" "$work/out/meadow_amd64.deb" "$work/out/meadow.x86_64.rpm" "$dist/"
      for file in Meadow-x86_64.AppImage meadow_amd64.deb meadow.x86_64.rpm; do
        note_release "$file" "$version"
      done
      ;;
  esac
  rm -rf "$work/out"
done

(cd "$dist" && sha256sum Meadow-Setup.exe Meadow-x86_64.AppImage meadow_amd64.deb meadow.x86_64.rpm Meadow-macos.dmg 2>/dev/null) > "$dist/SHA256SUMS" || true
ls -lh "$dist"
