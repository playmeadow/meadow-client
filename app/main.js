"use strict";

const {app, BrowserWindow, ipcMain, net, screen, session, shell, webContents} = require("electron");
const fs = require("fs");
const path = require("path");
const device = require("./device.js");
const discord = require("./discord.js");
const log = require("./log.js");
const relay = require("./relay.js");
const updater = require("./updater.js");

// Burrow: a minimal client for the Burrow private server (Animal Jam Classic,
// under a name of its own): a login form, then the
// game and little else. it needs Electron 11 (the last with Flash support)
// and a Flash plugin from before Adobe's January 2021 shut-off; both sit
// beside this folder (../electron or ../electron-win, ../flash) and
// ../run.sh or ../run.bat starts it.

// Meadow, the experimental fork of Burrow, keeps what it stores on this
// computer (remembered accounts, settings, the game's cache) in a folder of
// its own, away from Burrow's "AJ Private Client": the two can run side by
// side, and an update Burrow downloaded is never started in Meadow's place.
// (Not when the caller chose the folder itself, --user-data-dir.)
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), "Meadow"));
}

// meadow:// links: the server's account page asks the client to sign it in
// ("Sign in with the Meadow client", meadow://account?n=<nonce>; index.html
// does the rest). windows and linux start a new copy with the link: the copy
// already running takes it, and the new one goes at once. a copy started to
// play beside the first still plays; only one that came with a link gives way.
// macOS hands the link to the running app (open-url) instead.
const LINK_PROTOCOL = "meadow";
const linkIn = argv => argv.find(arg => String(arg).toLowerCase().startsWith(`${LINK_PROTOCOL}://`)) || null;
let pendingLink = linkIn(process.argv);
if (!app.requestSingleInstanceLock() && pendingLink) {
  process.exit(0);
}

// the folder the client was installed with. this one may be an update
// (boot.js), kept elsewhere; the plugin and build.json stay beside that one.
const SHIPPED = global.burrow ? global.burrow.shipped : __dirname;
const VERSION = require("./package.json").version;
log.start(VERSION);

// a packaged build names its server in build.json (tools/build.sh --server)
const builtFor = () => {
  try {
    const {server} = JSON.parse(fs.readFileSync(path.join(SHIPPED, "build.json"), "utf8"));
    return typeof server === "string" && /^https?:\/\/[^\s]+$/.test(server) ? server : "";
  } catch (error) {
    return "";
  }
};
const DEFAULT_SERVER = process.env.AJ_SERVER || builtFor() || "http://127.0.0.1:8080";
const FLASH_VERSION = "32.0.0.330";
const LAUNCHER_VERSION = "1.5.7"; // the official launcher this stands in for
const FLASH_PLUGIN = process.env.AJ_FLASH_PLUGIN || path.join(SHIPPED, "..", "flash",
  process.platform === "win32" ? "pepflashplayer.dll" : process.platform === "darwin" ? "PepperFlashPlayer.plugin" : "libpepflashplayer.so");
const GAME_PRELOAD = path.join(__dirname, "gamePreload.js");
const CAPTCHA_PRELOAD = path.join(__dirname, "captchaPreload.js");
// where cloudflare's captcha widget comes from
const CAPTCHA_ORIGIN = "https://challenges.cloudflare.com";
const MAX_COPIES = 8;
// what has to be known before Chromium starts, so cannot live in the page's
// own storage: {gpu: false} when the graphics card is not to be used.
const SETTINGS_FILE = path.join(app.getPath("userData"), "client-settings.json");
const readSettings = () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) || {};
  }
  catch (err) {
    return {};
  }
};

let win = null;
// the server the game is being played on ("https://play.burrow.moe"),
// once a login chose it: the one address the game page may load from.
let gameOrigin = null;
// the captcha window (below), while it is open, and its server's origin
let captchaBox = null;
let captchaServer = null;
// it has a session of its own, with a rule of its own on what it may load:
// electron does not say which window a page itself is being loaded for.
const CAPTCHA_PARTITION = "aj-captcha";
// --aj-no-renderer-sandbox: the pages' processes outside Chromium's sandbox,
// as they were, should the Flash plugin not start with it.
const SANDBOXED = !app.commandLine.hasSwitch("aj-no-renderer-sandbox");
// the main process's own calls to a server get a session to themselves, so
// that the rule below about what pages may load does not apply to them.
const API_PARTITION = "aj-api";
// the theatre's browser (experimental, index.html): a webview of its own
// over the theatre screen, in a session of its own that is kept in memory
// only, so nothing it visits stays and none of it reaches the game.
const BROWSER_PARTITION = "aj-browser";
let browserSession = null;
const isBrowser = contents => browserSession !== null && contents.session === browserSession;
const webAddress = text => {
  try {
    const url = new URL(String(text));
    return url.protocol === "https:" || url.protocol === "http:";
  }
  catch (err) {
    return false;
  }
};

// two copies cannot share one HTTP cache: the second to start moves the
// first one's cache aside, and the first then gets broken game files out of
// it. so each copy running takes a numbered slot, and every slot but the
// first has a cache folder of its own. the folders stay, so a second window
// loads the game from disk as fast as the first does. A slot is a lock file
// holding the process id of the copy that has it.
const pidRuns = pid => {
  try {
    process.kill(pid, 0);
    return true;
  }
  catch (err) {
    return err.code === "EPERM";
  }
};
const takeSlot = () => {
  const folder = app.getPath("userData");
  fs.mkdirSync(folder, {recursive: true});
  for (let slot = 1; slot <= MAX_COPIES; slot++) {
    const lock = path.join(folder, `copy-${slot}.lock`);
    try {
      const holder = Number(fs.readFileSync(lock, "utf8"));
      if (holder && holder !== process.pid && pidRuns(holder)) {
        continue;
      }
      fs.unlinkSync(lock);
    }
    catch (err) {
      // no such lock: the slot is free.
    }
    try {
      fs.writeFileSync(lock, String(process.pid), {flag: "wx"});
      app.on("quit", () => {
        try {
          fs.unlinkSync(lock);
        }
        catch (quitErr) {
          // the next copy to want the slot sees that this one is gone.
        }
      });
      return slot;
    }
    catch (err) {
      // another copy took it this instant; try the next.
    }
  }
  return 0;
};
// not when the caller chose the folders itself (--user-data-dir).
if (!app.commandLine.hasSwitch("user-data-dir")) {
  const slot = takeSlot();
  if (slot !== 1) {
    app.commandLine.appendSwitch("disk-cache-dir", path.join(app.getPath("userData"), slot ? `Cache-copy-${slot}` : `Cache-copy-pid-${process.pid}`));
  }
}

// the game reads the launcher's version out of the browser's user agent and
// refuses to start below 1.5.3, so the client names itself as the official
// launcher there.
app.userAgentFallback = `${app.userAgentFallback.replace(/ AJPrivateClient\/\S+/, "")} AJClassic/${LAUNCHER_VERSION}`;

// the 2019 flash plugin cannot start inside chromium's sandbox on linux; an
// installed copy is started from a menu entry or an AppImage, not run.sh
if (process.platform === "linux" && !app.commandLine.hasSwitch("no-sandbox")) {
  app.commandLine.appendSwitch("no-sandbox");
}
app.commandLine.appendSwitch("ppapi-flash-path", FLASH_PLUGIN);
app.commandLine.appendSwitch("ppapi-flash-version", FLASH_VERSION);
// Chromium slows a page down once its window is covered, minimised or out
// of focus. with two game windows side by side that is one of them always:
// its animal stutters and its connection can time out. keep both at speed.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// the game is Flash, which draws with the processor whatever happens; the
// graphics card only puts the finished picture on the screen. Chromium's GPU
// process costs about 120 MB for that (measured: 134 MB of the client's 437
// MB of private memory, 18 MB without it). it is used unless "Use GPU" under
// Advanced was turned off (the owner's choice, once the game drew more
// pictures a second than its own 24); without it the little that is left
// runs inside the main process. --aj-gpu turns it on whatever is set.
const usesGpu = readSettings().gpu !== false || app.commandLine.hasSwitch("aj-gpu");
if (!usesGpu) {
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("in-process-gpu");
}

// automatic updates (updater.js): on unless turned off, and only for an
// installed build, which knows its server.
ipcMain.handle("setAutoUpdate", (event, on) => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({...readSettings(), autoUpdate: on === true}));
  if (on === true && updates) {
    updates.check();
  }
});
ipcMain.on("restartToUpdate", () => {
  app.relaunch();
  app.exit(0);
});
let updates = null;
let updateState = null; // the last thing the updater said, for a page loaded after it

ipcMain.handle("setGpu", (event, on) => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({...readSettings(), gpu: on === true}));
});
// some graphics cards (or their drivers) leave the game on its loading
// screen for good; players got past it by turning "Use GPU" off. the page
// asks for that itself when the game has not drawn in time (index.html).
ipcMain.on("gpuFallback", () => {
  if (!usesGpu || app.commandLine.hasSwitch("aj-gpu")) {
    return;
  }
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({...readSettings(), gpu: false}));
  app.relaunch();
  app.exit(0);
});

// what the server is told about this computer at sign-in (device.js).
ipcMain.handle("device", () => device.device());

ipcMain.handle("info", () => ({
  // as this run was started; a change takes effect at the next start.
  gpu: usesGpu,
  gpuSetting: readSettings().gpu !== false,
  defaultServer: DEFAULT_SERVER,
  version: VERSION,
  // null when this copy is not one that updates itself
  autoUpdate: builtFor() && global.burrow ? readSettings().autoUpdate !== false : null,
  update: updateState,
  launcherVersion: LAUNCHER_VERSION,
  // what the game is told it runs on; it only knows these two.
  os: process.platform === "darwin" ? "mac" : "win",
  flashPluginFound: fs.existsSync(FLASH_PLUGIN),
}));

// resolves to the local port the game is to connect to (see relay.js), 0
// when none could be opened.
ipcMain.handle("useServer", (event, serverUrl, gamePort, gameHost) => {
  const url = new URL(serverUrl);
  gameOrigin = url.origin;
  // the server may name another host for the game: a web address behind
  // cloudflare carries no game port. a local server is never sent elsewhere.
  const loopback = ["127.0.0.1", "localhost", "::1"];
  const named = /^[a-z0-9.-]{1,253}$/i.test(String(gameHost || "")) && !loopback.includes(gameHost) && !loopback.includes(url.hostname);
  return relay.use(named ? gameHost : url.hostname, Number(gamePort), url.protocol === "https:");
});

// what a page may load. the login page is ours and talks to whichever server
// was typed in. the game page gets its own server and nothing else: the
// game is an old Flash plugin in an old browser, and anything that made it
// fetch from elsewhere (a picture named in a chat line once did) would hand
// a stranger the player's address, or the plugin a stranger's file.
const LOCAL_SCHEMES = ["file:", "devtools:", "chrome-devtools:", "chrome:", "data:", "blob:", "about:"];

// the theatre's video (the server's game page: the room's, played by staff,
// and the player's own from its link box): the YouTube and Vimeo players
// and what they load, measured in this Electron. a host here counts with
// every host under it.
const VIDEO_PLAYER_HOSTS = [
  "youtube-nocookie.com", "youtube.com", "ytimg.com", "ggpht.com", "googlevideo.com",
  "jnn-pa.googleapis.com", "gstatic.com", "www.google.com",
  "vimeo.com", "vimeocdn.com",
];
const videoPlayerHost = host => VIDEO_PLAYER_HOSTS.some(known => host === known || host.endsWith(`.${known}`));
// the player's own sound or video file (the game page's link box): the one
// address they typed, as the game page says it (ownVideo below), and where
// it redirects. a <video>'s file is an "other" request in this Electron, as
// is everything the Flash plugin asks for; those stay on the game's server
// otherwise.
let ownMedia = null;
const ownMediaRequests = new Set(); // request ids of it, through redirects
const withoutHash = url => url.href.replace(/#.*$/, "");
const mayLoad = details => {
  let url;
  try {
    url = new URL(details.url);
  }
  catch (err) {
    return false;
  }
  if (LOCAL_SCHEMES.includes(url.protocol)) {
    return true;
  }
  if (win && details.webContentsId === win.webContents.id) {
    return url.protocol === "http:" || url.protocol === "https:";
  }
  if (gameOrigin !== null && url.origin === gameOrigin) {
    return true;
  }
  if (gameOrigin === null || (url.protocol !== "https:" && url.protocol !== "http:") || details.resourceType === "object") {
    return false;
  }
  if (details.resourceType === "other" || details.resourceType === "media") {
    if (ownMediaRequests.has(details.id) || (ownMedia !== null && withoutHash(url) === ownMedia)) {
      ownMediaRequests.add(details.id);
      return true;
    }
    return false;
  }
  return url.protocol === "https:" && videoPlayerHost(url.hostname.toLowerCase());
};

// the link the player put in the theatre's box, or "" when it stopped: from
// the login page (index.html), which hears it from the game page. resolves
// once requests for it may go.
ipcMain.handle("ownVideo", (event, link) => {
  if (!win || event.sender !== win.webContents) {
    return false;
  }
  ownMedia = null;
  try {
    const url = new URL(String(link || ""));
    if (url.protocol === "https:" || url.protocol === "http:") {
      ownMedia = withoutHash(url);
    }
  }
  catch (err) {
    // stopped, or not an address
  }
  return ownMedia !== null;
});

// the server's /api only answers its own pages (it checks the Origin
// header), and this client's page is a file. so the calls the page
// needs are made from here, where a request carries no origin.
const API_CALLS = {status: ["GET", "/api/status"], register: ["POST", "/api/register"], ban: ["POST", "/api/ban"],
  accountTicket: ["POST", "/account/api/client-ticket"]};
const apiRequest = (serverUrl, call, body) => new Promise(resolve => {
  const [method, apiPath] = API_CALLS[call];
  const started = Date.now();
  const request = net.request({method, url: new URL(apiPath, serverUrl).href, partition: API_PARTITION});
  const give = (status, text) => {
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    }
    catch (err) {
      // not this server, or not there.
    }
    resolve({status, body: parsed, ms: Date.now() - started});
  };
  const timer = setTimeout(() => request.abort(), 8000);
  request.on("response", response => {
    const chunks = [];
    response.on("data", chunk => chunks.push(chunk));
    response.on("end", () => {
      clearTimeout(timer);
      give(response.statusCode, Buffer.concat(chunks).toString("utf8"));
    });
  });
  request.on("error", () => {
    clearTimeout(timer);
    give(0, "");
  });
  request.on("abort", () => give(0, ""));
  if (method === "POST") {
    request.setHeader("Content-Type", "application/json");
    request.write(JSON.stringify(body || {}));
  }
  request.end();
});
ipcMain.handle("api", async (event, serverUrl, call, body) => {
  if (!API_CALLS[call] || !/^https?:\/\//.test(String(serverUrl))) {
    return {status: 0, body: {}};
  }
  // a sign-up says which computer it is on, as a sign-in does (device.js).
  const first = await apiRequest(serverUrl, call, call === "register" ? {...body, device: await device.device()} : body);
  if (call !== "status" || first.status === 0) {
    return first;
  }
  // the ping. the first request may have had to make the connection (and
  // a packet of that lost costs a whole second, or three); the one right
  // after it goes over that connection, which is what the game's own does.
  const second = await apiRequest(serverUrl, call, body);
  return second.status === 0 ? first : second;
});

// the server's captcha (its lib/captcha.js). cloudflare's widget does not
// run in the login page, which is a file, so it is the server's own
// /captcha page in a small window over the login screen. resolves to the
// answer, or "" when the window is closed without one.
ipcMain.handle("captcha", (event, serverUrl, action) => new Promise(resolve => {
  let server;
  try {
    server = new URL(String(serverUrl));
  }
  catch (err) {
    resolve("");
    return;
  }
  if (!win || event.sender.id !== win.webContents.id || !/^https?:$/.test(server.protocol) || captchaBox) {
    resolve("");
    return;
  }
  captchaServer = server.origin;
  const box = new BrowserWindow({
    parent: win,
    modal: true,
    width: 360,
    height: 200,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#12001f",
    title: "Meadow",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: SANDBOXED,
      preload: CAPTCHA_PRELOAD,
      partition: CAPTCHA_PARTITION,
    },
  });
  box.setMenu(null);
  captchaBox = box;
  const id = box.webContents.id;
  let answered = false;
  const answer = token => {
    if (!answered) {
      answered = true;
      resolve(token);
    }
  };
  const onDone = (doneEvent, token) => {
    if (doneEvent.sender.id === id) {
      answer(typeof token === "string" && token.length <= 2048 ? token : "");
      box.close();
    }
  };
  ipcMain.on("captchaDone", onDone);
  box.on("closed", () => {
    ipcMain.removeListener("captchaDone", onDone);
    captchaBox = null;
    captchaServer = null;
    answer("");
  });
  box.loadURL(new URL(`/captcha?action=${action === "signup" ? "signup" : "login"}`, server).href).catch(() => {
    answer("");
    if (!box.isDestroyed()) {
      box.close();
    }
  });
}));

// what the client's processes use: the game is the "Pepper Plugin" one.
// memory is each process's own (private) memory where the system says it
// (Windows does). the working set, the other figure there is, counts what
// processes share once for each of them, and came to nearly twice as much.
ipcMain.handle("metrics", () => {
  const all = app.getAppMetrics();
  const sum = rows => ({
    cpu: Math.round(rows.reduce((total, row) => total + row.cpu.percentCPUUsage, 0)),
    memoryMb: Math.round(rows.reduce((total, row) => total + (row.memory.privateBytes || row.memory.workingSetSize), 0) / 1024),
  });
  return {total: sum(all), game: sum(all.filter(row => /plugin/i.test(row.type))), processes: all.length};
});

// how often the game's picture really changes on the screen: the frames
// the window's compositor presents for the game's page, counted for a
// second. this is what reaches the eye, whatever the game says it drew.
// the count stops near 60, which is as fast as frames are handed over.
let countingFrames = false;
ipcMain.handle("painted", async (event, gameContentsId) => {
  const game = webContents.fromId(Number(gameContentsId));
  if (!game || game.hostWebContents !== event.sender || countingFrames) {
    return null;
  }
  countingFrames = true;
  let frames = 0;
  try {
    game.beginFrameSubscription(true, () => {
      frames++;
    });
    await new Promise(resolve => setTimeout(resolve, 1000));
    game.endFrameSubscription();
    return frames;
  }
  catch (err) {
    return null;
  }
  finally {
    countingFrames = false;
  }
});

// screenshots and room pictures: Pictures/Meadow
const picturesFolder = () => path.join(app.getPath("pictures"), "Meadow");

ipcMain.handle("screenshot", async (event, gameContentsId) => {
  const game = webContents.fromId(Number(gameContentsId));
  if (!game || game.hostWebContents !== event.sender) {
    return null;
  }
  const image = await game.capturePage();
  if (image.isEmpty()) {
    return null;
  }
  const folder = picturesFolder();
  await fs.promises.mkdir(folder, {recursive: true});
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
  const file = path.join(folder, `${stamp}.png`);
  await fs.promises.writeFile(file, image.toPNG());
  return file;
});

// a picture of the whole room, drawn by the game (game.html ajRoomPicture):
// a PNG in base64, saved beside the screenshots. resolves to the file's
// path, or null.
const MAX_ROOM_PICTURE_BASE64 = 64 * 1024 * 1024;
ipcMain.handle("roomPicture", async (event, image) => {
  if (!win || event.sender !== win.webContents || typeof image !== "string" || !image || image.length > MAX_ROOM_PICTURE_BASE64
    || !/^[A-Za-z0-9+/=\r\n]+$/.test(image)) {
    return null;
  }
  const bytes = Buffer.from(image, "base64");
  // a PNG's own first bytes
  if (!bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
    return null;
  }
  const folder = picturesFolder();
  await fs.promises.mkdir(folder, {recursive: true});
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
  const file = path.join(folder, `${stamp} room.png`);
  await fs.promises.writeFile(file, bytes);
  return file;
});

// the colour panel's dropper (the game's ColorTable, game.html
// ajPickScreenColour): a colour from anywhere on any screen. Electron 11 has
// no EyeDropper, so each screen gets a window of its own (picker.html) that
// shows a picture of it taken while the window was hidden, and the colour
// clicked in any of them is the answer: "#RRGGBB", "" when there was none
// (Esc, a right click), or "!" when no picture of the screen was to be had
// (the game then picks from itself).
let picking = null; // the pick under way: a promise of its answer
ipcMain.handle("pickColour", event => {
  if (!win || event.sender !== win.webContents) {
    log.write("warn", "main", "[colour] pick asked by something other than the client's window");
    return "";
  }
  if (picking) {
    return picking;
  }
  // Wayland shows an app no picture of the screen (it comes back black):
  // "!" has the game pick from itself
  if (process.platform === "linux" && (process.env.XDG_SESSION_TYPE === "wayland" || process.env.WAYLAND_DISPLAY)) {
    log.write("info", "main", "[colour] Wayland: the game picks from itself");
    return "!";
  }
  log.write("info", "main", `[colour] picking from ${screen.getAllDisplays().length} screen(s)`);
  picking = new Promise(resolve => {
    const windows = [];
    let ready = 0;
    let shown = false;
    let finished = false;
    // once: closing the windows below runs their "closed" handler, which
    // would otherwise answer "" before the colour picked got out
    const finish = colour => {
      if (finished) {
        return;
      }
      finished = true;
      ipcMain.removeListener("pickerReady", onReady);
      ipcMain.removeListener("pickerDone", onDone);
      for (const one of windows) {
        if (!one.isDestroyed()) {
          one.destroy();
        }
      }
      picking = null;
      log.write("info", "main", `[colour] picked ${colour || "nothing"}`);
      if (win && !win.isDestroyed()) {
        win.focus();
      }
      resolve(colour);
    };
    const ours = event => windows.some(one => !one.isDestroyed() && one.webContents === event.sender);
    // every screen's picture is ready (or not to be had): all shown at once
    const onReady = (readyEvent, ok) => {
      if (!ours(readyEvent)) {
        return;
      }
      if (!ok) {
        log.write("warn", "main", "[colour] no picture of a screen could be taken");
        finish("!");
        return;
      }
      ready++;
      if (ready === windows.length && !shown) {
        shown = true;
        for (const one of windows) {
          one.show();
        }
        windows[0].focus();
      }
    };
    const onDone = (doneEvent, colour) => {
      if (ours(doneEvent)) {
        finish(/^#[0-9A-F]{6}$/.test(String(colour)) ? String(colour) : "");
      }
    };
    ipcMain.on("pickerReady", onReady);
    ipcMain.on("pickerDone", onDone);
    for (const display of screen.getAllDisplays()) {
      const {x, y, width, height} = display.bounds;
      const one = new BrowserWindow({x, y, width, height, show: false, frame: false, resizable: false, movable: false,
        alwaysOnTop: true, skipTaskbar: true, enableLargerThanScreen: true, backgroundColor: "#000000",
        webPreferences: {preload: path.join(__dirname, "pickerPreload.js"), contextIsolation: true, nodeIntegration: false}});
      one.setAlwaysOnTop(true, "screen-saver");
      // closed some other way (Alt+F4): nothing was picked
      one.on("closed", () => finish(""));
      windows.push(one);
      one.loadFile(path.join(__dirname, "picker.html"), {query: {display: String(display.id),
        width: String(Math.round(width * display.scaleFactor)), height: String(Math.round(height * display.scaleFactor))}});
    }
  });
  return picking;
});

ipcMain.on("showFile", (event, file) => {
  // only what the handlers above wrote.
  if (path.dirname(String(file)) === picturesFolder()) {
    shell.showItemInFolder(String(file));
  }
});

// the client's log (log.js), shown in its folder for a bug report
ipcMain.on("showLog", event => {
  if (win && event.sender === win.webContents && log.file()) {
    shell.showItemInFolder(log.file());
  }
});

ipcMain.on("openPage", (event, url) => {
  if (/^https?:\/\//.test(String(url))) {
    shell.openExternal(String(url));
  }
});

// a picture the game prints (its print kits and art studios, through the
// game page's ajPrint): {image, a JPEG in base64; width; height}. it goes on
// a page of its own, in a window that is never shown and runs no script,
// and the system's print dialog opens for it; nothing of it is kept after.
const MAX_PRINT_BASE64 = 40 * 1024 * 1024;
ipcMain.on("printImage", (event, picture) => {
  const image = picture && typeof picture.image === "string" ? picture.image : "";
  if (!image || image.length > MAX_PRINT_BASE64 || !/^[A-Za-z0-9+/=\r\n]+$/.test(image)) {
    return;
  }
  const landscape = Number(picture.width) > Number(picture.height);
  let folder;
  try {
    folder = fs.mkdtempSync(path.join(app.getPath("temp"), "burrow-print-"));
    fs.writeFileSync(path.join(folder, "picture.jpg"), Buffer.from(image, "base64"));
    fs.writeFileSync(path.join(folder, "print.html"), "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>"
      + `@page { margin: 0; size: ${landscape ? "landscape" : "portrait"}; } html, body { margin: 0; height: 100%; }`
      + " img { display: block; width: 100%; height: 100%; object-fit: contain; }</style></head><body><img src=\"picture.jpg\"></body></html>");
  }
  catch (error) {
    return;
  }
  const cleanUp = () => {
    try {
      fs.rmdirSync(folder, {recursive: true});
    }
    catch (error) {
      // the temporary folder goes another time
    }
  };
  const page = new BrowserWindow({show: false, webPreferences: {javascript: false, sandbox: true, contextIsolation: true}});
  page.webContents.once("did-finish-load", () => {
    page.webContents.print({silent: false, printBackground: true}, () => {
      page.destroy();
      cleanUp();
    });
  });
  page.webContents.once("did-fail-load", () => {
    page.destroy();
    cleanUp();
  });
  page.loadFile(path.join(folder, "print.html"));
});

// a meadow:// link (above), once the login page is there to take it: only
// the account page's nonce goes on, and the window comes to the front.
const accountNonce = link => {
  try {
    const url = new URL(link);
    const nonce = url.searchParams.get("n") || "";
    return url.protocol === `${LINK_PROTOCOL}:` && url.hostname === "account" && /^[0-9a-f]{48}$/.test(nonce) ? nonce : null;
  }
  catch (err) {
    return null;
  }
};
const takeLink = () => {
  if (!pendingLink || !win || win.webContents.isLoading()) {
    return;
  }
  const nonce = accountNonce(pendingLink);
  pendingLink = null;
  if (nonce) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    win.webContents.send("accountLink", nonce);
  }
};
app.on("second-instance", (event, argv) => {
  pendingLink = linkIn(argv) || pendingLink;
  takeLink();
});
app.on("open-url", (event, link) => {
  event.preventDefault();
  pendingLink = link;
  takeLink();
});

// Discord rich presence (discord.js): {appId, state, start, url} while the
// game is open, null when it is not.
ipcMain.on("presence", (event, info) => {
  discord.set(info && typeof info === "object" ? info : null);
});

ipcMain.on("toggleFullscreen", () => {
  if (win) {
    win.setFullScreen(!win.isFullScreen());
  }
});

app.on("web-contents-created", (event, contents) => {
  // the game page is a guest: it gets our preload and nothing more.
  contents.on("will-attach-webview", (attachEvent, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // the theatre's browser: a web page like any, with nothing of ours.
    if (params.partition === BROWSER_PARTITION) {
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.sandbox = true;
      webPreferences.plugins = false;
      webPreferences.webviewTag = false;
      if (!webAddress(params.src)) {
        params.src = "about:blank";
      }
      return;
    }
    if (params.partition) {
      attachEvent.preventDefault();
      return;
    }
    webPreferences.preload = GAME_PRELOAD;
    webPreferences.backgroundThrottling = false;
    webPreferences.sandbox = SANDBOXED;
  });
  // the login page stays the login page, and the game page stays on its
  // server: a page that arrived any other way would inherit what these have.
  contents.on("will-navigate", (navigateEvent, url) => {
    if (isBrowser(contents)) {
      if (!webAddress(url)) {
        navigateEvent.preventDefault();
      }
      return;
    }
    let origin = null;
    try {
      origin = new URL(url).origin;
    }
    catch (err) {
      // not an address: refused below.
    }
    if (contents.getType() !== "webview" || gameOrigin === null || origin !== gameOrigin) {
      navigateEvent.preventDefault();
    }
  });
  contents.on("new-window", (windowEvent, url) => {
    windowEvent.preventDefault();
    // the theatre's browser opens a new window's page in itself
    if (isBrowser(contents)) {
      if (webAddress(url)) {
        contents.loadURL(url);
      }
      return;
    }
    if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
  });
  // keys are seen here even while the Flash plugin has the keyboard.
  contents.on("before-input-event", (inputEvent, input) => {
    if (input.type !== "keyDown" || !win) {
      return;
    }
    if (input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
      inputEvent.preventDefault();
    }
    else if (input.key === "Escape" && win.isFullScreen()) {
      win.setFullScreen(false);
    }
    else if (input.key === "F12") {
      contents.isDevToolsOpened() ? contents.closeDevTools() : contents.openDevTools({mode: "detach"});
      inputEvent.preventDefault();
    }
    // F9 too, though it does nothing now (the room picture is the button's
    // alone, as it holds the game still for seconds in a big room): an older
    // game file opened its old item giver on it.
    else if (input.key === "F10" || input.key === "F9" || input.key === "F7") {
      win.webContents.send("shortcut", input.key);
      inputEvent.preventDefault();
    }
  });
});

app.whenReady().then(() => {
  device.device(); // read now, so the first sign-in does not wait
  session.defaultSession.webRequest.onBeforeRequest((details, answer) => answer({cancel: !mayLoad(details)}));
  // only watching: in Electron 11 a listener that may change requests
  // (onBeforeSendHeaders, even one that changes nothing) stops YouTube's player.
  session.defaultSession.webRequest.onCompleted(details => ownMediaRequests.delete(details.id));
  session.defaultSession.webRequest.onErrorOccurred(details => ownMediaRequests.delete(details.id));
  // the theatre's browser: the web, and nothing of this computer's; no
  // camera, microphone, notifications or the like, and no downloads. it says
  // it is plain Chrome, which sites know, not this client.
  browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.setUserAgent(browserSession.getUserAgent().replace(/ (?:Electron|Burrow|aj-private-client)\/\S+/gi, ""));
  browserSession.setPermissionRequestHandler((contents, permission, answer) => answer(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.on("will-download", downloadEvent => downloadEvent.preventDefault());
  browserSession.webRequest.onBeforeRequest((details, answer) => {
    let url = null;
    try {
      url = new URL(details.url);
    }
    catch (err) {
      // not an address: refused.
    }
    answer({cancel: !url || !["https:", "http:", "data:", "blob:", "about:"].includes(url.protocol)});
  });
  session.fromPartition(CAPTCHA_PARTITION).webRequest.onBeforeRequest((details, answer) => {
    let url = null;
    try {
      url = new URL(details.url);
    }
    catch (err) {
      // not an address: refused.
    }
    answer({cancel: !url || !(["data:", "blob:", "about:"].includes(url.protocol) || url.origin === captchaServer || url.origin === CAPTCHA_ORIGIN)});
  });
  win = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 900,
    minHeight: 578,
    useContentSize: true,
    backgroundColor: "#12001f",
    title: "Meadow",
    icon: path.join(__dirname, "icon.png"),
    // --aj-hidden: no window on the desktop, for looking at the pages by script.
    show: !app.commandLine.hasSwitch("aj-hidden"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: SANDBOXED,
      webviewTag: true,
      plugins: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.setMenu(null);
  win.webContents.on("did-finish-load", takeLink);
  win.loadFile(path.join(__dirname, "index.html"));
  // an installed copy answers meadow:// links (the installers say so too;
  // this keeps it so after an update or a move). a copy run from the
  // repository leaves them to the installed one.
  if (builtFor() && !app.isDefaultProtocolClient(LINK_PROTOCOL)) {
    app.setAsDefaultProtocolClient(LINK_PROTOCOL);
  }
  if (builtFor() && global.burrow) {
    updates = updater.start({
      server: builtFor(),
      shell: global.burrow.shell,
      running: VERSION,
      on: () => readSettings().autoUpdate !== false,
      tell: state => {
        updateState = state;
        if (win) {
          win.webContents.send("update", state);
        }
      },
    });
  }
  for (const [name, on] of [["enter-full-screen", true], ["leave-full-screen", false]]) {
    win.on(name, () => win.webContents.send("fullscreen", on));
  }
  win.on("closed", () => {
    win = null;
  });
});

app.on("window-all-closed", () => app.quit());
