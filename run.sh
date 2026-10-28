#!/bin/sh
# starts Burrow, the client of the Burrow private server. extra arguments go to Electron.
#
# --no-sandbox: the 2019 Flash plugin cannot start inside Chromium's sandbox
# on a current Linux, so the game would never load without it. the client only
# ever opens its own login page and the private server's game page.
here=$(dirname "$(readlink -f "$0")")
exec "$here/electron/electron" "$here/app" --no-sandbox "$@"
