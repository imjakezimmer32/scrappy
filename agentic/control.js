// What Scrappy may do on this computer and in Cursor.
// He can drive the machine. He does not get to harm it, hide, or ignore you.

const APPS = new Set(["cursor", "code", "explorer", "notepad", "chrome", "msedge"]);

const HARMFUL = [
  /format\s+[a-z]:/i,
  /\b(diskpart|bcdedit|cipher\s+\/w|vssadmin)\b/i,
  /\brm\s+-rf\b/i,
  /\bremove-item\b.*-recurse/i,
  /\bdel\s+\/s\b/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\b(mimikatz|sekurlsa|procdump)\b/i,
  /\b(password|credential|secret|token|cookie|id_rsa|\.pem)\b/i,
  /\b(defender|realtimeprotection|disable-mppreference)\b/i,
  /invoke-expression|downloadstring|iex\b/i,
  /\bcurl\b.*\|\s*(ba)?sh/i,
  /push\s+.*\bmain\b/i,
  /push\s+.*--force/i,
  /\breg\s+delete\b/i,
  /\bnet\s+user\b/i,
  /\bschtasks\b.*\/create/i,
];

function judge(input = {}) {
  const action = String(input.action || "").trim().toLowerCase();
  const target = String(input.target || input.text || input.goal || "").trim();
  const blob = [action, input.target, input.text, input.goal].filter(Boolean).join(" ");
  if (HARMFUL.some((pattern) => pattern.test(blob))) {
    return { decision: "refuse", reason: "That would hurt the machine or your account.", action };
  }
  if (action.startsWith("cursor-") || action === "cursor") {
    return { decision: "allow", reason: "Cursor work.", action: action === "cursor" ? "cursor-start" : action };
  }
  if (action === "open-url" && /^https:\/\//i.test(target)) {
    return { decision: "allow", reason: "Open a web page.", action };
  }
  if (action === "open-app" && APPS.has(target.toLowerCase())) {
    return { decision: "allow", reason: "Open an app you use.", action };
  }
  if (action === "type-text" && target && target.length <= 500) {
    return { decision: "allow", reason: "Type where you are working.", action };
  }
  if (action === "read-file" && target && !/password|credential|secret|token|cookie/i.test(target)) {
    return { decision: "allow", reason: "Read a file.", action };
  }
  if (!action) return { decision: "ask", reason: "I need to know what to do.", action };
  return { decision: "ask", reason: "I'll check with you before that.", action };
}

function respect(input = {}) {
  const decision = judge(input);
  if (decision.decision === "refuse") return decision;
  if (input.voiceActive || input.chatOpen) {
    if (decision.action === "type-text") {
      return { decision: "ask", reason: "You're talking. I won't type over you.", action: decision.action };
    }
  }
  return decision;
}

module.exports = { APPS, judge, respect };
