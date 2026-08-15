const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("scrappy", {
  onGrow(callback) {
    ipcRenderer.on("scrappy:grow", (_event, payload) => callback(payload));
  },
  onAck(callback) {
    ipcRenderer.on("scrappy:ack", (_event, payload) => callback(payload));
  },
  // Every display's rectangle in overlay-local coordinates.
  onLayout(callback) {
    ipcRenderer.on("scrappy:layout", (_event, screens) => callback(screens));
  },
  ack() {
    ipcRenderer.send("scrappy:ack-from-ui");
  },
  testGrow() {
    ipcRenderer.send("scrappy:test-grow");
  },
  // The overlay is click-through except where Scrappy actually is.
  setInteractive(value) {
    ipcRenderer.send("scrappy:set-interactive", Boolean(value));
  },
  hideScrappy() {
    ipcRenderer.send("scrappy:hide");
  },
  quitApp() {
    ipcRenderer.send("scrappy:quit");
  },
  isVisible() {
    try {
      return ipcRenderer.sendSync("scrappy:pref-visible") !== false;
    } catch {
      return true;
    }
  },
  onVisible(callback) {
    ipcRenderer.on("scrappy:set-visible", (_event, on) => callback(Boolean(on)));
  },
  onChatOpen(callback) {
    ipcRenderer.on("scrappy:chat-open", () => callback());
  },
  onVoiceStart(callback) {
    ipcRenderer.on("scrappy:voice-start", () => callback());
  },
  chatFocus(on) {
    ipcRenderer.send("scrappy:chat-focus", Boolean(on));
  },
  // Who he's talking to, and the setup panel. The renderer never sees a key —
  // setupStatus reports only whether things are configured, not what with.
  userName() {
    return ipcRenderer.invoke("scrappy:user-name");
  },
  openSetup() {
    ipcRenderer.send("scrappy:open-setup");
  },
  setupStatus() {
    return ipcRenderer.invoke("scrappy:setup-status");
  },
  // Voice: the renderer only ever sees an expiring signed URL, never the key.
  voiceSignedUrl() {
    return ipcRenderer.invoke("scrappy:voice-signed-url");
  },
  systemContext() {
    return ipcRenderer.invoke("scrappy:system-context");
  },
  recallContext() {
    return ipcRenderer.invoke("scrappy:recall-context");
  },
  recallBrief() {
    return ipcRenderer.invoke("scrappy:recall-brief");
  },
  recallTool(name, args) {
    return ipcRenderer.invoke("scrappy:recall-tool", name, args || {});
  },
  cursorAgent(action, args) {
    return ipcRenderer.invoke("scrappy:cursor-agent", action, args || {});
  },
  cursorChats(action, args) {
    return ipcRenderer.invoke("scrappy:cursor-chats", action, args || {});
  },
  voiceStatus() {
    return ipcRenderer.invoke("scrappy:voice-status");
  },
  processNote(text) {
    return ipcRenderer.invoke("scrappy:process-note", text);
  },
  processEvent(event) {
    return ipcRenderer.invoke("scrappy:process-event", event || {});
  },
  conversationStart(info) {
    return ipcRenderer.invoke("scrappy:conversation-start", info || {});
  },
  conversationEvent(sessionId, event) {
    return ipcRenderer.invoke("scrappy:conversation-event", sessionId, event || {});
  },
  conversationEnd(sessionId, extra) {
    return ipcRenderer.invoke("scrappy:conversation-end", sessionId, extra || {});
  },
  processRecent(limit) {
    return ipcRenderer.invoke("scrappy:process-recent", limit);
  },
  onWake(callback) {
    ipcRenderer.on("scrappy:wake", (_event, payload) => callback(payload));
  },
  wakePause() {
    ipcRenderer.send("scrappy:wake-pause");
  },
  wakeResume() {
    ipcRenderer.send("scrappy:wake-resume");
  },
});
