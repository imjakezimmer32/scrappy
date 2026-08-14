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
  hideBuddy() {
    ipcRenderer.send("workbuddy:hide");
  },
  quitApp() {
    ipcRenderer.send("workbuddy:quit");
  },
  isVisible() {
    try {
      return ipcRenderer.sendSync("workbuddy:pref-visible") !== false;
    } catch {
      return true;
    }
  },
  onVisible(callback) {
    ipcRenderer.on("workbuddy:set-visible", (_event, on) => callback(Boolean(on)));
  },
  onChatOpen(callback) {
    ipcRenderer.on("workbuddy:chat-open", () => callback());
  },
  onVoiceStart(callback) {
    ipcRenderer.on("workbuddy:voice-start", () => callback());
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
  cursorAgent(action, args) {
    return ipcRenderer.invoke("workbuddy:cursor-agent", action, args || {});
  },
  cursorChats(action, args) {
    return ipcRenderer.invoke("workbuddy:cursor-chats", action, args || {});
  },
  voiceStatus() {
    return ipcRenderer.invoke("workbuddy:voice-status");
  },
  processNote(text) {
    return ipcRenderer.invoke("workbuddy:process-note", text);
  },
  processEvent(event) {
    return ipcRenderer.invoke("workbuddy:process-event", event || {});
  },
  conversationStart(info) {
    return ipcRenderer.invoke("workbuddy:conversation-start", info || {});
  },
  conversationEvent(sessionId, event) {
    return ipcRenderer.invoke("workbuddy:conversation-event", sessionId, event || {});
  },
  conversationEnd(sessionId, extra) {
    return ipcRenderer.invoke("workbuddy:conversation-end", sessionId, extra || {});
  },
  processRecent(limit) {
    return ipcRenderer.invoke("workbuddy:process-recent", limit);
  },
  onWake(callback) {
    ipcRenderer.on("workbuddy:wake", (_event, payload) => callback(payload));
  },
  wakePause() {
    ipcRenderer.send("workbuddy:wake-pause");
  },
  wakeResume() {
    ipcRenderer.send("workbuddy:wake-resume");
  },
});
