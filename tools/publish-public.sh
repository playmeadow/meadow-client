#!/usr/bin/env bash
# copies this repository as it stands at its last commit, minus what stays
# private, into the public one and pushes it:
#
#   tools/publish-public.sh [--no-push]
#
# no markdown file of any kind goes public. the public repository has a
# history of its own: nothing of this one's
# history goes there, so a file that was ever committed here and is private
# never shows up in an old public commit. the public repository's own files
# (its README, .gitignore and licence, written there) are left as they are.
set -euo pipefail

name=burrow-client
remote=git@github.com:burrow-dev/$name.git
# what stays private: nothing beyond what .gitignore keeps out already
# (Electron, the Flash plugin, the builds)
private=()

# the public repository's own: never replaced or removed from here
public_own=(README.md .gitignore LICENSE)

here=$(cd "$(dirname "$0")/.." && pwd)
public=${BURROW_PUBLIC_DIR:-$HOME/burrow-public/$name}
push=1
[ "${1:-}" = "--no-push" ] && push=0

cd "$here"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "commit first: the public copy is made from the last commit" >&2
  exit 1
fi
source=$(git rev-parse --short HEAD)
ssh_command=$(git config --get core.sshCommand || true)

if [ ! -d "$public/.git" ]; then
  mkdir -p "$public"
  git -C "$public" init -q -b main
  git -C "$public" remote add origin "$remote"
fi
git -C "$public" config user.name "$(git config user.name)"
git -C "$public" config user.email "$(git config user.email)"
[ -n "$ssh_command" ] && git -C "$public" config core.sshCommand "$ssh_command"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive HEAD | tar -x -C "$work"
for path in "${private[@]+"${private[@]}"}"; do
  rm -rf "${work:?}/$path"
done
# no markdown file goes public, of any kind (the owner's rule)
find "$work" -name '*.md' -delete

# a last look before anything leaves: none of the game's code or SWFs
leaked=$(find "$work" \( -name '*.swf' -o -name '*.as' -o -name '*.pem' -o -name '*.md' \) -print)
if [ -n "$leaked" ]; then
  echo "refused: these would have gone public:" >&2
  echo "$leaked" >&2
  exit 1
fi

rm -f "$work/.gitignore"

# start from what is on github: changes made there are kept
if git -C "$public" fetch -q origin main 2>/dev/null; then
  git -C "$public" reset -q --hard origin/main
fi

# the public tree becomes exactly this, beside the public repository's own
keep=(! -name .git)
for name in "${public_own[@]}"; do
  keep+=(! -name "$name")
  rm -rf "${work:?}/$name"
done
find "$public" -mindepth 1 -maxdepth 1 "${keep[@]}" -exec rm -rf {} +
cp -a "$work/." "$public/"
cd "$public"
git add -A
# its .gitignore must not hold back a file meant to go public
missing=$(cd "$work" && find . -type f | sed 's|^\./||' | sort | comm -23 - <(git -C "$public" ls-files --cached | sort))
if [ -n "$missing" ]; then
  echo "refused: the public .gitignore holds these back ($(echo "$missing" | wc -l) files), e.g.:" >&2
  echo "$missing" | head -5 >&2
  exit 1
fi
if git diff --cached --quiet; then
  echo "the public copy is already up to date"
  exit 0
fi
git commit -q -m "Brought up to date with the private repository ($source)"
echo "committed in $public: $(git log -1 --format='%h %s')"
if [ "$push" = 1 ]; then
  git push -q -u origin main
  echo "pushed to $remote"
fi
