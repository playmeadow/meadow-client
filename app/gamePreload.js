"use strict";

const { ipcRenderer, contextBridge } = require("electron");

const sendWhitelist = new Set()
  .add("initialized")
  .add("fps")
  .add("openPage")
  .add("browser")
  .add("ownVideo")
  .add("presence")
  .add("printImage")
  .add("pickColour")
  .add("roomPicture")
  .add("reloadGame")
  .add("reportError")
  .add("signupCompleted");

const receiveWhitelist = new Set()
  .add("flashVarsReady")
  .add("hud")
  .add("roomShot")
  .add("ownVideoReady")
  .add("browserSupported")
  .add("browserState")
  .add("removed")
  .add("pickedColour");

contextBridge.exposeInMainWorld(
  "ipc", {
    sendToHost: (channel, ...args) => {
      if (sendWhitelist.has(channel)) {
        ipcRenderer.sendToHost(channel, ...args);
      }
    },
    // this client picks colours from the screen (game.html ajPickScreenColour)
    pickColour: true,
    on: (channel, listener) => {
      if (receiveWhitelist.has(channel)) {
        ipcRenderer.on(channel, listener);
      }
    }
  }
);

ipcRenderer.on("redirect-url", (event, url) => {
  console.log("REDIRECT");
});
