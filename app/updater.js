"use strict";

const {app, net} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// automatic updates of this folder (boot.js starts the newest). an installed
// build asks the server it was built for, at <server>/client/latest.json,
// which names a bundle: every file of the folder, gzipped JSON, signed with
// a key whose private half stays on the machine the builds are made on
// (tools/make-update.js). a bundle that fails the signature is never
// unpacked, so a server that was broken into cannot hand out code.
// the new version is unpacked into the data folder and starts with the next
// start of the client.

const PUBLIC_KEY = crypto.createPublicKey(`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQxKqXkj/3XNZZjOwSDlsb+ot8Ax+NzOyeLPL+McAKMg=
-----END PUBLIC KEY-----
`);
const FIRST_CHECK_MS = 10000;
const CHECK_EVERY_MS = 30 * 60000; // latest.json is a few hundred bytes
const TIMEOUT_MS = 60000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const PARTITION = "aj-update";
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/;
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;

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

const readJson = file => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  catch (err) {
    return null;
  }
};

// writes `text` so that a reader sees the old file or the new, never half
const writeWhole = (file, text) => {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};

const get = (url, maxBytes) => new Promise((resolve, reject) => {
  const request = net.request({url, partition: PARTITION});
  const timer = setTimeout(() => request.abort(), TIMEOUT_MS);
  request.on("response", response => {
    if (response.statusCode !== 200) {
      clearTimeout(timer);
      reject(new Error(`${url}: ${response.statusCode}`));
      request.abort();
      return;
    }
    const chunks = [];
    let size = 0;
    response.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        request.abort();
      }
      else {
        chunks.push(chunk);
      }
    });
    response.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
  request.on("abort", () => {
    clearTimeout(timer);
    reject(new Error(`${url}: stopped`));
  });
  request.on("error", err => {
    clearTimeout(timer);
    reject(err);
  });
  request.end();
});

// `options`: {server: the address the build was made for, shell: boot.js's
// SHELL, running: the version running now, tell(state): {state: "ready" |
// "download", version}, on(): whether updates are wanted (a setting)}.
const start = options => {
  const updates = path.join(app.getPath("userData"), "updates");
  const source = new URL("/client/", options.server).href;
  let busy = false;

  const unpack = (manifest, bundle) => {
    const signature = Buffer.from(String(manifest.signature || ""), "base64");
    if (!crypto.verify(null, bundle, PUBLIC_KEY, signature)) {
      throw new Error("the signature does not match");
    }
    const {version, shell, files} = JSON.parse(zlib.gunzipSync(bundle).toString("utf8"));
    if (version !== manifest.version || !VERSION.test(version) || !Number.isInteger(shell) || shell > options.shell) {
      throw new Error("the bundle is not the version named");
    }
    const names = Object.keys(files || {});
    if (!["boot.js", "main.js", "index.html", "package.json"].every(name => names.includes(name))
      || !names.every(name => FILE_NAME.test(name) && typeof files[name] === "string")) {
      throw new Error("the bundle's files are not a client");
    }
    const folder = path.join(updates, `app-${version}`);
    const part = `${folder}.part`;
    fs.rmdirSync(part, {recursive: true});
    for (const name of names) {
      const file = path.join(part, ...name.split("/"));
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, Buffer.from(files[name], "base64"));
    }
    fs.rmdirSync(folder, {recursive: true});
    fs.renameSync(part, folder);
    writeWhole(path.join(updates, "current.json"), JSON.stringify({version, shell}));
    // older ones go, but never the one running
    for (const name of fs.readdirSync(updates)) {
      const full = path.join(updates, name);
      if (/^app-/.test(name) && full !== folder && full !== global.burrow.app) {
        fs.rmdirSync(full, {recursive: true});
      }
    }
    return version;
  };

  const check = async () => {
    if (busy || !options.on()) {
      return;
    }
    busy = true;
    try {
      fs.mkdirSync(updates, {recursive: true});
      const manifest = JSON.parse((await get(`${source}latest.json`, MAX_MANIFEST_BYTES)).toString("utf8"));
      const staged = readJson(path.join(updates, "current.json"));
      const have = staged && newer(staged.version, options.running) ? staged.version : options.running;
      const bad = readJson(path.join(updates, "bad.json"));
      if (!VERSION.test(manifest.version) || !newer(manifest.version, have) || (bad && bad.version === manifest.version)) {
        if (have !== options.running) {
          options.tell({state: "ready", version: have});
        }
        return;
      }
      if (!Number.isInteger(manifest.shell) || manifest.shell > options.shell) {
        options.tell({state: "download", version: manifest.version});
        return;
      }
      if (!/^app-[\d.]+\.burrow$/.test(String(manifest.file))) {
        throw new Error("latest.json names no bundle");
      }
      const version = unpack(manifest, await get(`${source}${manifest.file}`, MAX_BUNDLE_BYTES));
      console.log(`[update] ${version} is ready for the next start`);
      options.tell({state: "ready", version});
    }
    catch (err) {
      console.log(`[update] ${err.message}`);
    }
    finally {
      busy = false;
    }
  };

  setTimeout(check, FIRST_CHECK_MS);
  setInterval(check, CHECK_EVERY_MS);
  return {check};
};

module.exports = {start};
