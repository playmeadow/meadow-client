"use strict";

// the screen colour picker's window (main.js pickColour, picker.html): a
// picture of its screen, taken while the window is still hidden, for the
// page to show; the colour clicked, or nothing, back to main.js.

const {contextBridge, desktopCapturer, ipcRenderer} = require("electron");

const query = new URLSearchParams(location.search);
const displayId = query.get("display");
const width = Number(query.get("width"));
const height = Number(query.get("height"));

contextBridge.exposeInMainWorld("picker", {
  // a PNG data URL of this window's screen, or "" when it could not be had
  screen: async () => {
    try {
      const sources = await desktopCapturer.getSources({types: ["screen"], thumbnailSize: {width, height}});
      const own = sources.find(source => String(source.display_id) === displayId) || (sources.length === 1 ? sources[0] : null);
      return own && !own.thumbnail.isEmpty() ? own.thumbnail.toDataURL() : "";
    }
    catch (error) {
      return "";
    }
  },
  ready: ok => ipcRenderer.send("pickerReady", Boolean(ok)),
  // "#RRGGBB", or "" to let it be
  done: colour => ipcRenderer.send("pickerDone", /^#[0-9A-F]{6}$/.test(String(colour)) ? String(colour) : ""),
});
