#!/usr/bin/env node
"use strict";

// makes an update for the clients already installed (app/updater.js): app/
// as it is, minus build.json, gzipped and signed, plus the latest.json that
// names it. both go to the server's client-updates/ folder, which it serves
// at /client/; committing and pushing the server is what hands it out.
//
//   tools/make-update.js [--out <folder>] [--key <file>]
//
// raise "version" in app/package.json first: an update must be newer than
// the one published. the key is ~/.config/meadow/update-key.pem; without it
// no update can be signed that installed clients accept (BUILDING.md).

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = path.resolve(option("--out", path.join(os.homedir(), "burrow-public", "meadow", "meadow-server", "client-updates")));
const keyFile = option("--key", path.join(os.homedir(), ".config", "meadow", "update-key.pem"));

const fail = message => {
  console.error(message);
  process.exit(1);
};

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

const app = path.join(root, "app");
const {version} = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
const shellMatch = /^const SHELL = (\d+);$/m.exec(fs.readFileSync(path.join(app, "boot.js"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version) || !shellMatch) {
  fail("app/package.json needs a version like 1.2.3, and app/boot.js its SHELL");
}
if (!fs.existsSync(keyFile)) {
  fail(`no signing key at ${keyFile}`);
}
fs.mkdirSync(out, {recursive: true});
const published = path.join(out, "latest.json");
if (fs.existsSync(published)) {
  const before = JSON.parse(fs.readFileSync(published, "utf8")).version;
  if (!newer(version, before)) {
    fail(`${before} is published already: raise "version" in app/package.json above it`);
  }
}

const files = {};
const walk = folder => {
  for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
    const full = path.join(folder, entry.name);
    const name = path.relative(app, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      walk(full);
    }
    else if (name !== "build.json") {
      files[name] = fs.readFileSync(full).toString("base64");
    }
  }
};
walk(app);

const shell = Number(shellMatch[1]);
const bundle = zlib.gzipSync(JSON.stringify({version, shell, files}), {level: 9});
const signature = crypto.sign(null, bundle, crypto.createPrivateKey(fs.readFileSync(keyFile)));
const file = `app-${version}.burrow`;
for (const old of fs.readdirSync(out).filter(name => /^app-.*\.burrow$/.test(name))) {
  fs.unlinkSync(path.join(out, old));
}
fs.writeFileSync(path.join(out, file), bundle);
fs.writeFileSync(published, `${JSON.stringify({version, shell, file, signature: signature.toString("base64")}, null, 2)}\n`);
console.log(`${file}: ${Object.keys(files).length} files, ${Math.round(bundle.length / 1024)} KB, in ${out}`);
