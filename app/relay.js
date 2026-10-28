"use strict";

const net = require("net");
const tls = require("tls");

// the patched ajclient.swf always opens its game socket to 127.0.0.1. when
// the private server runs on another machine, this relays that local port to
// it, over TLS when the server's address is an https:// one.

let server = null;

const stop = () => {
  if (server) {
    server.close();
    server = null;
  }
};

// relays a local port of this copy's own to remoteHost:port and resolves to
// that local port, which the game is then told to connect to; for a local
// server it relays nothing and resolves to `port` itself. 0 when no port
// could be opened.
//
// A port of its own, because two copies logged in to different servers
// cannot share one: the second used to fail to open the game's port, say
// nothing, and send its game (and its login token) through the first copy's
// relay to the first copy's server.
module.exports.use = (remoteHost, port, secure) => new Promise(resolve => {
  stop();
  if (["127.0.0.1", "localhost", "::1"].includes(remoteHost)) {
    resolve(port);
    return;
  }
  const relay = net.createServer(local => {
    const remote = secure ? tls.connect({host: remoteHost, port}) : net.connect(port, remoteHost);
    // the game sends small messages, often two at once: without these the
    // second waits for the first's answer from the other end (Nagle).
    local.setNoDelay(true);
    remote.setNoDelay(true);
    local.pipe(remote);
    remote.pipe(local);
    const close = () => {
      local.destroy();
      remote.destroy();
    };
    local.on("error", close);
    remote.on("error", close);
    local.on("close", close);
    remote.on("close", close);
  });
  server = relay;
  relay.on("error", () => resolve(0));
  relay.listen(0, "127.0.0.1", () => resolve(relay.address().port));
});
