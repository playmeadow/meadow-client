"use strict";

const {contextBridge, ipcRenderer} = require("electron");

// for the server's /captcha page in its window (main.js): hands the answer back.
contextBridge.exposeInMainWorld("burrowCaptcha", {
  done: token => ipcRenderer.send("captchaDone", String(token)),
});
