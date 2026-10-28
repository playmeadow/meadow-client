"use strict";

const {app} = require("electron");
const fs = require("fs");
const path = require("path");

// what the client starts with: the newest copy of this folder the computer
// has. an installed build keeps the copy it came with and fetches newer ones
// into its own data folder (updater.js), which it can always write to, the
// install folder not always (/opt, the AppImage, Applications). a copy run
// from the repository (no build.json) always runs as it is.
//
// this file, Electron and the Flash plugin are the "shell", which an update
// cannot change: a version that needs a newer shell is a new download.

const SHELL = 1;

global.burrow = {shipped: __dirname, shell: SHELL, app: __dirname};

// the same data folder main.js uses
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), "Meadow"));
}
const UPDATES = path.join(app.getPath("userData"), "updates");
const STAGED = path.join(UPDATES, "current.json");

const versionOf = folder => {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, "package.json"), "utf8")).version;
  }
  catch (err) {
    return null;
  }
};
// is version `one` ("1.2.3") later than `other`?
const newer = (one, other) => {
  const a = String(one).split(".").map(Number);
  const b = String(other).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {
      return (a[i] || 0) > (b[i] || 0);
    }
  }
  return false;
};

const chosen = (() => {
  if (!fs.existsSync(path.join(__dirname, "build.json")) || app.commandLine.hasSwitch("aj-no-updates")) {
    return __dirname;
  }
  try {
    const staged = JSON.parse(fs.readFileSync(STAGED, "utf8"));
    const folder = path.join(UPDATES, `app-${staged.version}`);
    if (/^\d+\.\d+\.\d+$/.test(staged.version) && staged.shell <= SHELL && newer(staged.version, versionOf(__dirname))
      && versionOf(folder) === staged.version) {
      return folder;
    }
  }
  catch (err) {
    // nothing fetched yet
  }
  return __dirname;
})();
global.burrow.app = chosen;

try {
  require(path.join(chosen, "main.js"));
}
catch (err) {
  if (chosen === __dirname) {
    throw err;
  }
  // an update that does not start is forgotten, and the installed copy
  // starts in a clean process (the broken one may have half set itself up).
  console.error(`the update in ${chosen} did not start: ${err.stack}`);
  // (updater.js does not fetch that version again.)
  try {
    fs.writeFileSync(path.join(UPDATES, "bad.json"), JSON.stringify({version: versionOf(chosen)}));
    fs.unlinkSync(STAGED);
  }
  catch (writeErr) {
    // already gone
  }
  app.relaunch();
  app.exit(1);
}
