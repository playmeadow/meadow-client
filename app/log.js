"use strict";

const {app} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");

// the client's log, for players to attach to a bug report: what the client
// itself says, what its pages and the game print to their consoles
// (warnings and errors), and crashes and pages that would not load. it is
// <data folder>/logs/client.log; once that is MAX_BYTES it becomes
// client.old.log (the one before it goes) and a new one starts, so the two
// are never more than twice that. "Show client log" in the client's
// settings (index.html) opens the folder.
//
// what could let someone into an account is kept out: an address's query
// (where sign-in tokens travel) and anything written as password=, token=
// and the like.

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRY = 4000; // characters of one entry; a long stack is cut
// a page printing in a loop fills the log with one thing: past this many
// entries in BURST_MS the rest are counted, not written
const BURST_ENTRIES = 200;
const BURST_MS = 10000;

let file = null;
let oldFile = null;
let size = 0;
let header = ""; // which client and computer: the first line of each file
let burstStart = 0;
let burstCount = 0;
let leftOut = 0;

const SECRET = /\b(password|passwd|pass|token|session|secret|auth|nonce|code|key)(["']?\s*[:=]\s*["']?)[^\s&"',;}]+/gi;
const QUERY = /\b(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi;
const scrub = text => text.replace(QUERY, "$1?…").replace(SECRET, "$1$2[hidden]");

const stamp = () => new Date().toISOString();

const append = text => {
  if (file === null) {
    return;
  }
  try {
    const bytes = Buffer.byteLength(text);
    if (size + bytes > MAX_BYTES) {
      fs.renameSync(file, oldFile);
      fs.writeFileSync(file, header);
      size = Buffer.byteLength(header);
    }
    fs.appendFileSync(file, text);
    size += bytes;
  }
  catch (err) {
    // a log that cannot be written is no reason to stop the client
  }
};

// `level` "info", "warn" or "error"; `source` what said it ("main", "page",
// "game"); `parts` as console.log takes them.
const write = (level, source, ...parts) => {
  const now = Date.now();
  if (now - burstStart > BURST_MS) {
    if (leftOut > 0) {
      append(`${stamp()} warn  [log] ${leftOut} more entries in ${BURST_MS / 1000} seconds were left out\n`);
    }
    burstStart = now;
    burstCount = 0;
    leftOut = 0;
  }
  if (++burstCount > BURST_ENTRIES) {
    leftOut++;
    return;
  }
  let text = scrub(util.format(...parts));
  if (text.length > MAX_ENTRY) {
    text = `${text.slice(0, MAX_ENTRY)}… (${text.length - MAX_ENTRY} more characters)`;
  }
  append(`${stamp()} ${level.padEnd(5)} [${source}] ${text.replace(/\r?\n/g, "\n    ")}\n`);
};

// Chromium's console levels: 0 verbose, 1 info, 2 warning, 3 error
const CONSOLE_LEVELS = [null, null, "warn", "error"];

const watchContents = contents => {
  const source = contents.getType() === "webview" ? "game" : "page";
  contents.on("console-message", (event, level, message, line, sourceId) => {
    if (CONSOLE_LEVELS[level]) {
      write(CONSOLE_LEVELS[level], source, `${message}${sourceId ? ` (${path.basename(String(sourceId).split("?")[0])}:${line})` : ""}`);
    }
  });
  contents.on("did-fail-load", (event, code, description, url, isMainFrame) => {
    if (code !== -3) { // -3: the load was stopped for another, not a failure
      write("warn", source, `could not load ${url}${isMainFrame ? "" : " (part of the page)"}: ${description} (${code})`);
    }
  });
  contents.on("plugin-crashed", (event, name, version) => write("error", source, `the ${name} plugin ${version} crashed`));
  contents.on("unresponsive", () => write("warn", source, "stopped responding"));
  contents.on("responsive", () => write("info", source, "responding again"));
};

// starts the log; the data folder must be chosen by then
const start = version => {
  const dir = path.join(app.getPath("userData"), "logs");
  try {
    fs.mkdirSync(dir, {recursive: true});
    file = path.join(dir, "client.log");
    oldFile = path.join(dir, "client.old.log");
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  }
  catch (err) {
    file = null;
    return;
  }
  header = `${stamp()} info  [main] Meadow ${version}, Electron ${process.versions.electron}, ${os.type()} ${os.release()} ${process.arch}, ${Math.round(os.totalmem() / 1048576)} MB\n`;
  append(header);
  // the main process's own console goes to the log as well
  for (const [method, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]]) {
    const original = console[method].bind(console);
    console[method] = (...parts) => {
      original(...parts);
      write(level, "main", ...parts);
    };
  }
  process.on("uncaughtExceptionMonitor", err => write("error", "main", `uncaught: ${err && err.stack ? err.stack : err}`));
  process.on("unhandledRejection", err => write("error", "main", `unhandled rejection: ${err && err.stack ? err.stack : err}`));
  app.on("web-contents-created", (event, contents) => watchContents(contents));
  app.on("render-process-gone", (event, contents, details) => write("error", "main", `a page's process ended: ${details.reason} (exit code ${details.exitCode})`));
  app.on("child-process-gone", (event, details) => {
    if (details.reason !== "clean-exit") {
      write("error", "main", `the ${details.name || details.type} process ended: ${details.reason} (exit code ${details.exitCode})`);
    }
  });
  app.on("will-quit", () => write("info", "main", "quit"));
};

module.exports = {start, write, file: () => file};
