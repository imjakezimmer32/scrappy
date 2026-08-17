const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workbuddy", {
  onGrow(callback) {
    ipcRenderer.on("workbuddy:grow", (_event, payload) => callback(payload));
  },
  onAck(callback) {
    ipcRenderer.on("workbuddy:ack", (_event, payload) => callback(payload));
  },
  // Every display's rectangle in overlay-local coordinates.
  onLayout(callback) {
    ipcRenderer.on("workbuddy:layout", (_event, screens) => callback(screens));
  },
  ack() {
    ipcRenderer.send("workbuddy:ack-from-ui");
  },
  testGrow() {
    ipcRenderer.send("workbuddy:test-grow");
  },
  // The overlay is click-through except where Cog actually is.
  setInteractive(value) {
    ipcRenderer.send("workbuddy:set-interactive", Boolean(value));
  },
  onChatOpen(callback) {
    ipcRenderer.on("workbuddy:chat-open", () => callback());
  },
  callActive(on) {
    ipcRenderer.send("workbuddy:call-active", Boolean(on));
  },
  chatFocus(on) {
    ipcRenderer.send("workbuddy:chat-focus", Boolean(on));
  },
  // Voice: the renderer only ever sees an expiring signed URL, never the key.
  voiceSignedUrl() {
    return ipcRenderer.invoke("workbuddy:voice-signed-url");
  },
  systemContext() {
    return ipcRenderer.invoke("workbuddy:system-context");
  },
  recallContext() {
    return ipcRenderer.invoke("workbuddy:recall-context");
  },
  recallBrief() {
    return ipcRenderer.invoke("workbuddy:recall-brief");
  },
  recallTool(name, args) {
    return ipcRenderer.invoke("workbuddy:recall-tool", name, args || {});
  },
  voiceStatus() {
    return ipcRenderer.invoke("workbuddy:voice-status");
  },
});
