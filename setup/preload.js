// Bridge for the setup window. Deliberately tiny, and deliberately one-way on
// secrets: the panel can write an API key and can ask whether one is set, but
// there is no channel that hands a key back to the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("setup", {
  read() {
    return ipcRenderer.invoke("setup:read");
  },
  write(patch) {
    return ipcRenderer.invoke("setup:write", patch || {});
  },
  clearSecret(key) {
    return ipcRenderer.invoke("setup:clear-secret", String(key || ""));
  },
  buildVoice() {
    return ipcRenderer.invoke("setup:build-voice");
  },
});
