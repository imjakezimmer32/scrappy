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
  localVoiceInstalled() {
    return ipcRenderer.invoke("setup:local-voice-installed");
  },
  installLocalVoice() {
    return ipcRenderer.invoke("setup:install-local-voice");
  },
  personaplexInstalled() {
    return ipcRenderer.invoke("setup:personaplex-installed");
  },
  installPersonaplex() {
    return ipcRenderer.invoke("setup:install-personaplex");
  },
});
