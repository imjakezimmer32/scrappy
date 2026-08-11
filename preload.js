const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbuddy", {
  onGrow(callback) {
    ipcRenderer.on("workbuddy:grow", (_event, payload) => callback(payload));
  },
  onAck(callback) {
    ipcRenderer.on("workbuddy:ack", (_event, payload) => callback(payload));
  },
  ack() {
    ipcRenderer.send("workbuddy:ack-from-ui");
  },
  testGrow() {
    ipcRenderer.send("workbuddy:test-grow");
  },
});
