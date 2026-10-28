"use strict";

const {app} = require("electron");
const {execFile} = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// what the server is told about this computer at every sign-in, for
// keeping a banned player's computer out (the server's lib/devices.js).
// nothing is sent as it is: each value is SHA-256 of
// "burrow-device:<kind>:<value>", the value in small letters.
//
//   os       the system's own id: MachineGuid (Windows), IOPlatformUUID
//            (macOS), /etc/machine-id (Linux)
//   board    the board's id (Windows: the SMBIOS UUID) or the computer's
//            serial number (macOS); Linux keeps both from users
//   disk     the disks' serial numbers
//   mac      the network cards' addresses, not virtual ones
//   install  an id of the client's own, kept in two or three places
//
// what looks wrong (the system id missing, or not shaped as it always is,
// or the client's own ids disagreeing) goes as notes. it is read once, at
// start, and takes a second or two on Windows (PowerShell).

const TIMEOUT_MS = 15000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[0-9a-f]{64}$/;
// network cards that are not one: virtual machines' and containers' own.
const VIRTUAL_NAME = /^(lo|docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|wg|zt|utun|awdl|llw|bridge|ham|tailscale|vEthernet)/i;
const VIRTUAL_MAC = /^(00:05:69|00:0c:29|00:1c:14|00:50:56|08:00:27|0a:00:27|52:54:00|00:15:5d|00:1c:42|00:16:3e|02:42)/;

const hash = (kind, value) => crypto.createHash("sha256").update(`burrow-device:${kind}:${String(value).trim().toLowerCase()}`).digest("hex");

const run = (file, args) => new Promise(resolve => {
  execFile(file, args, {timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024}, (error, stdout) => resolve(error ? "" : String(stdout)));
});

const readFile = file => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  }
  catch (err) {
    return "";
  }
};

const writeFile = (file, text) => {
  try {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, text);
  }
  catch (err) {
    // somewhere it cannot be kept; the others may do.
  }
};

const windows = async () => {
  const guid = (/MachineGuid\s+REG_SZ\s+(\S+)/i.exec(await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"])) || [])[1] || "";
  const cim = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-CimInstance Win32_ComputerSystemProduct).UUID; '--'; Get-CimInstance Win32_DiskDrive | ForEach-Object { $_.SerialNumber }"]);
  const [board, disks] = cim.split(/^--\s*$/m);
  return {os: guid, osShape: UUID, board: (board || "").trim(), disks: (disks || "").split(/\r?\n/)};
};

const mac = async () => {
  const ioreg = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  const field = name => ((new RegExp(`"${name}"\\s*=\\s*"([^"]+)"`)).exec(ioreg) || [])[1] || "";
  const storage = await run("system_profiler", ["SPNVMeDataType", "SPSerialATADataType"]);
  const disks = [];
  const serial = /Serial Number:\s*(\S+)/g;
  let found = serial.exec(storage);
  while (found) {
    disks.push(found[1]);
    found = serial.exec(storage);
  }
  return {os: field("IOPlatformUUID"), osShape: UUID, board: field("IOPlatformSerialNumber"), disks};
};

const linux = async () => {
  let disks = [];
  try {
    // the names say the model and the serial ("ata-Samsung_SSD_860_S3Z9NB0K123456X"),
    // and anyone may read them; not partitions, USB sticks or their other names.
    disks = fs.readdirSync("/dev/disk/by-id").filter(name => /^(ata|nvme|scsi|mmc)-/.test(name) && !/-part\d+$/.test(name)
      && !/^nvme-(eui|nvme)\./.test(name));
  }
  catch (err) {
    // no such folder: a container, say.
  }
  return {os: readFile("/etc/machine-id") || readFile("/var/lib/dbus/machine-id"), osShape: MACHINE_ID, board: "", disks};
};

const macAddresses = () => {
  const found = new Set();
  const cards = os.networkInterfaces();
  for (const name of Object.keys(cards)) {
    for (const card of cards[name]) {
      const address = String(card.mac || "").toLowerCase();
      // the second bit of the first byte marks an address made up by the system (random, or virtual).
      const madeUp = (parseInt(address.slice(0, 2), 16) & 2) === 2;
      if (!card.internal && address && address !== "00:00:00:00:00:00" && !madeUp && !VIRTUAL_NAME.test(name) && !VIRTUAL_MAC.test(address)) {
        found.add(address);
      }
    }
  }
  return [...found].sort();
};

// the client's own id: the same one wherever it is found, written back
// where it is missing. a new one when there is none.
const installId = async notes => {
  const places = [path.join(app.getPath("userData"), "install-id")];
  if (process.platform === "darwin") {
    places.push(path.join(os.homedir(), "Library", "Preferences", ".moe.burrow.install"));
  }
  else if (process.platform !== "win32") {
    places.push(path.join(os.homedir(), ".local", "share", ".burrow-install"));
  }
  const found = places.map(readFile).filter(text => TOKEN.test(text));
  // on Windows the registry is the other place.
  const registry = process.platform === "win32"
    ? (/Install\s+REG_SZ\s+(\S+)/i.exec(await run("reg", ["query", "HKCU\\Software\\Meadow", "/v", "Install"])) || [])[1] || "" : "";
  if (TOKEN.test(registry)) {
    found.push(registry);
  }
  if (new Set(found).size > 1) {
    notes.push("install_mismatch");
  }
  const id = found[0] || crypto.randomBytes(32).toString("hex");
  for (const place of places) {
    if (readFile(place) !== id) {
      writeFile(place, id);
    }
  }
  if (process.platform === "win32" && registry !== id) {
    await run("reg", ["add", "HKCU\\Software\\Meadow", "/v", "Install", "/t", "REG_SZ", "/d", id, "/f"]);
  }
  return id;
};

const collect = async () => {
  const notes = [];
  let read = {os: "", osShape: null, board: "", disks: []};
  try {
    read = process.platform === "win32" ? await windows() : process.platform === "darwin" ? await mac() : await linux();
  }
  catch (err) {
    // what could be read is sent; the rest is not.
  }
  const system = String(read.os || "").trim().toLowerCase().replace(/^\{|\}$/g, "");
  if (!system) {
    notes.push("os_missing");
  }
  else if (read.osShape && !read.osShape.test(system)) {
    notes.push("os_odd");
  }
  const disks = [...new Set((read.disks || []).map(serial => String(serial).trim()).filter(Boolean))].slice(0, 8);
  const ids = {
    install: hash("install", await installId(notes)),
    disk: disks.map(serial => hash("disk", serial)),
    mac: macAddresses().slice(0, 8).map(address => hash("mac", address)),
  };
  if (system) {
    ids.os = hash("os", system);
  }
  if (String(read.board || "").trim()) {
    ids.board = hash("board", read.board);
  }
  return {v: 1, ids, notes};
};

let collecting = null;
// {v: 1, ids, notes}, read once and kept.
const device = () => {
  if (!collecting) {
    collecting = collect().catch(() => ({v: 1, ids: {}, notes: ["failed"]}));
  }
  return collecting;
};

module.exports = {device};
