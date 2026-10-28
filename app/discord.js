"use strict";

// Discord rich presence: "Playing Meadow" on the player's Discord profile,
// with where they are in the game, the time since they started and a button
// to the download page. it goes through the Discord app on this computer
// (its local IPC socket, as Discord's own SDK does), so nothing about it
// leaves the computer from here. the server names its Discord application
// (its flashvars' discordAppId); a server that names none gets no presence.
// Discord not running, or started later: tried again now and then, quietly.

const crypto = require("crypto");
const net = require("net");
const path = require("path");

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
const RETRY_MS = 30000;
const MAX_FRAME = 64 * 1024;

// where the Discord app listens: a named pipe on Windows; elsewhere a socket
// in the runtime or temporary folder, or inside a Flatpak or Snap Discord's.
const socketPaths = () => {
  const numbers = [...Array(10).keys()];
  if (process.platform === "win32") {
    return numbers.map(n => `\\\\?\\pipe\\discord-ipc-${n}`);
  }
  const bases = [...new Set([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, "/tmp"].filter(Boolean))];
  const inside = ["", "app/com.discordapp.Discord", "app/com.discordapp.DiscordCanary", "snap.discord", "snap.discord-canary"];
  return bases.flatMap(base => inside.flatMap(folder => numbers.map(n => path.join(base, folder, `discord-ipc-${n}`))));
};

let wanted = null; // {appId, activity} to show, or null
let socket = null;
let socketAppId = null;
let ready = false;
let retry = null;
let buffer = Buffer.alloc(0);

// a request's id. (not crypto.randomUUID: Electron 11's Node 12 has none)
const nonce = () => crypto.randomBytes(16).toString("hex");

const frame = (op, data) => {
  const body = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

const send = () => {
  if (!socket || !ready || !wanted || wanted.appId !== socketAppId) {
    return;
  }
  socket.write(frame(OP_FRAME, {cmd: "SET_ACTIVITY", args: {pid: process.pid, activity: wanted.activity},
    nonce: nonce()}));
};

const drop = () => {
  if (socket) {
    socket.removeAllListeners();
    socket.on("error", () => {});
    socket.destroy();
  }
  socket = null;
  socketAppId = null;
  ready = false;
  buffer = Buffer.alloc(0);
};

const later = () => {
  if (!retry && wanted) {
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, RETRY_MS);
  }
};

const onData = chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 8) {
    const op = buffer.readInt32LE(0);
    const length = buffer.readInt32LE(4);
    if (length < 0 || length > MAX_FRAME) {
      drop();
      later();
      return;
    }
    if (buffer.length < 8 + length) {
      return;
    }
    const body = buffer.subarray(8, 8 + length);
    buffer = buffer.subarray(8 + length);
    let data = {};
    try {
      data = JSON.parse(body.toString("utf8"));
    }
    catch (err) {
      // not ours to understand; go on
    }
    if (op === OP_PING) {
      socket.write(frame(OP_PONG, data));
    }
    else if (op === OP_CLOSE) {
      drop();
      later();
      return;
    }
    else if (op === OP_FRAME && data.evt === "READY") {
      ready = true;
      send();
    }
  }
};

// tries each place Discord may listen, in turn.
const connect = (places = socketPaths()) => {
  if (!wanted || socket) {
    return;
  }
  if (!places.length) {
    later();
    return;
  }
  const appId = wanted.appId;
  const attempt = net.createConnection(places[0]);
  attempt.once("error", () => {
    attempt.destroy();
    if (socket === null) {
      connect(places.slice(1));
    }
  });
  attempt.once("connect", () => {
    if (!wanted || wanted.appId !== appId) {
      attempt.destroy();
      connect();
      return;
    }
    socket = attempt;
    socketAppId = appId;
    socket.removeAllListeners("error");
    socket.on("data", onData);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (socket === attempt) {
        drop();
        later();
      }
    });
    socket.write(frame(OP_HANDSHAKE, {v: 1, client_id: appId}));
  });
};

// what to show: {appId, state, start, url} while the game is open, or null.
const set = info => {
  const appId = info && /^\d{5,25}$/.test(String(info.appId)) ? String(info.appId) : null;
  if (!appId) {
    if (wanted) {
      wanted = null;
      if (socket && ready) {
        socket.write(frame(OP_FRAME, {cmd: "SET_ACTIVITY", args: {pid: process.pid}, nonce: nonce()}));
      }
    }
    return;
  }
  const activity = {
    details: "Playing Meadow",
    timestamps: {start: Number.isFinite(info.start) ? Math.floor(info.start) : Date.now()},
    assets: {large_image: "meadow", large_text: "Meadow"},
    instance: false,
  };
  if (typeof info.state === "string" && info.state.trim().length >= 2) {
    activity.state = info.state.trim().slice(0, 100);
  }
  if (typeof info.url === "string" && /^https:\/\/[^\s]{1,200}$/.test(info.url)) {
    activity.buttons = [{label: "Play Meadow", url: info.url}];
  }
  wanted = {appId, activity};
  if (socket && socketAppId !== appId) {
    drop();
  }
  if (socket) {
    send();
  }
  else if (!retry) {
    connect();
  }
};

module.exports = {set};
