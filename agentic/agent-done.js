// When a Cursor agent run finishes, say what landed, what is still open,
// and one next step. Celebrate only on a real success. Short runs stay quiet.

const MIN_DURATION_MS = 120000;
const SPEECH_MAX = 280;

const SUCCESS = new Set(["finished", "completed", "success"]);

function summarizeAgentDone(input = {}) {
  const force = input.force === true;
  if (!force && isUnderThreshold(input.durationMs)) return { skip: true };

  const status = String(input.status == null ? "" : input.status).trim().toLowerCase();
  const celebrate = SUCCESS.has(status);
  const failure = failureName(status);
  const parsed = parseResult(input.result);
  const prose = cleanClause(parsed.landed, 320);
  const empty = !prose;
  const landed = empty ? "The run ended with no writeup." : `${sentenceCase(prose)}.`;
  const stillOpen = asOpen(parsed.stillOpen);
  const nextStep = asAction(parsed.nextStep) || defaultNext({ failure, empty, stillOpen });
  const speech = buildSpeech({ celebrate, failure, landed, stillOpen, nextStep, empty });

  return { speech, landed, stillOpen, nextStep, celebrate };
}

function isUnderThreshold(durationMs) {
  return typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs < MIN_DURATION_MS;
}

function failureName(status) {
  if (status === "error") return "error";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "canceled") return "canceled";
  return null;
}

function defaultNext({ failure, empty, stillOpen }) {
  if (stillOpen) return `Finish ${stillOpen}`;
  if (failure === "error") return "Read the error log and retry the run";
  if (failure === "failed") return "Read the failure and retry the run";
  if (failure === "cancelled" || failure === "canceled") return "Start the run again from the last good step";
  if (empty) return "Check the files for what changed";
  return "Read the diff and confirm the change";
}

function buildSpeech({ celebrate, failure, landed, stillOpen, nextStep, empty }) {
  const step = decidedSentence(nextStep);
  const open = stillOpen ? `${cleanClause(stillOpen, 70)} is still open` : "";
  let head;

  if (failure) {
    const named = failureLead(failure);
    if (empty) {
      head = open
        ? `${named}, and it ended with no writeup, and ${open}`
        : `${named}, and it ended with no writeup`;
    } else {
      const detail = cleanClause(landed, 200);
      head = open ? `${named}: ${detail}, and ${open}` : `${named}: ${detail}`;
    }
  } else if (empty) {
    if (!celebrate) {
      head = open
        ? `The run stopped, and it ended with no writeup, and ${open}`
        : "The run stopped, and it ended with no writeup";
    } else {
      head = open ? `The run ended with no writeup, and ${open}` : "The run ended with no writeup";
    }
  } else if (!celebrate) {
    const detail = cleanClause(landed, 200);
    head = open ? `The run stopped: ${detail}, and ${open}` : `The run stopped: ${detail}`;
  } else {
    const detail = sentenceCase(cleanClause(landed, 200));
    head = open ? `${detail}, and ${open}` : detail;
  }

  return fitSpeech(scrub(head), step);
}

function failureLead(failure) {
  if (failure === "error") return "The run hit an error";
  if (failure === "failed") return "The run failed";
  if (failure === "cancelled") return "The run was cancelled";
  if (failure === "canceled") return "The run was canceled";
  return "The run stopped";
}

function decidedSentence(nextStep) {
  let action = cleanClause(nextStep, 160);
  action = action.replace(/^i'll\s+/i, "").replace(/^i will\s+/i, "");
  if (!action) action = "read the diff and confirm the change";
  if (/^[A-Z][a-z]/.test(action)) action = action.charAt(0).toLowerCase() + action.slice(1);
  let sentence = `I'll ${action}.`;
  if (sentence.length > 180) {
    sentence = `${clipWords(sentence.slice(0, -1), 179).replace(/[,\s]+$/g, "")}.`;
  }
  return sentence;
}

function fitSpeech(head, step) {
  let h = String(head || "").replace(/[.?\s]+$/g, "").trim();
  let s = String(step || "").trim();
  if (!s.endsWith(".")) s += ".";
  s = scrub(s);
  if (!/[.]$/.test(s)) s += ".";
  if (s.length > SPEECH_MAX) s = `${clipWords(s.slice(0, -1), SPEECH_MAX - 1)}.`;

  const maxHead = SPEECH_MAX - s.length - 1;
  if (h.length > maxHead) h = clipWords(h, Math.max(0, maxHead));
  if (!h) return s.slice(0, SPEECH_MAX);

  h = sentenceCase(h);
  let speech = scrub(`${h}. ${s}`);
  if (!/[.]$/.test(speech)) speech += ".";
  if (speech.length > SPEECH_MAX) {
    speech = `${clipWords(speech.slice(0, -1), SPEECH_MAX - 1).replace(/[,\s]+$/g, "")}.`;
  }
  if (speech.length > SPEECH_MAX) speech = speech.slice(0, SPEECH_MAX);
  return speech;
}

function parseResult(result) {
  if (typeof result === "string") return parseProse(result);
  if (typeof result === "number" && Number.isFinite(result)) {
    return { landed: String(result), stillOpen: null, nextStep: null, empty: false };
  }
  if (Array.isArray(result)) {
    const text = result
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .join("\n");
    return text ? parseProse(text) : blankParse();
  }
  if (result && typeof result === "object") {
    const landedText = pickString(result, ["landed", "summary", "text", "writeup", "body", "message", "output"]);
    const still = pickString(result, ["stillOpen", "still_open", "remaining", "leftOpen", "left_open"]);
    const next = pickString(result, ["nextStep", "next_step", "next"]);
    const prose = landedText ? parseProse(landedText) : blankParse();
    return {
      landed: prose.landed,
      stillOpen: still || prose.stillOpen,
      nextStep: next || prose.nextStep,
      empty: !prose.landed,
    };
  }
  return blankParse();
}

function blankParse() {
  return { landed: "", stillOpen: null, nextStep: null, empty: true };
}

function parseProse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return blankParse();
  const lines = trimmed.split(/\r?\n/);
  const labelRe = /^(landed|summary|what landed|still open|remaining|left to do|next step|next)\s*:/i;
  if (lines.some((line) => labelRe.test(line.trim()))) return parseLines(lines);
  return parseInline(trimmed);
}

function parseLines(lines) {
  const buckets = { landed: [], stillOpen: [], nextStep: [] };
  let mode = "landed";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const labeled = line.match(/^(landed|summary|what landed|still open|remaining|left to do|next step|next)\s*:\s*(.*)$/i);
    if (labeled) {
      mode = modeFor(labeled[1]);
      if (labeled[2].trim()) buckets[mode].push(labeled[2].trim());
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    buckets[mode].push((bullet ? bullet[1] : line).trim());
  }
  const landed = buckets.landed.join(" ").trim();
  return {
    landed,
    stillOpen: buckets.stillOpen.join("; ").trim() || null,
    nextStep: buckets.nextStep.join(" ").trim() || null,
    empty: !landed,
  };
}

function parseInline(text) {
  let rest = text;
  let nextStep = null;
  let stillOpen = null;

  const nextMatch = rest.match(/(?:^|[.]\s+)(?:next step|next)\s*:\s*(.+)$/i);
  if (nextMatch) {
    nextStep = nextMatch[1].trim();
    rest = rest.slice(0, nextMatch.index).trim();
  }
  const openMatch = rest.match(/(?:^|[.]\s+)(?:still open|remaining|left to do)\s*:\s*(.+)$/i);
  if (openMatch) {
    stillOpen = openMatch[1].trim();
    rest = rest.slice(0, openMatch.index).trim();
  }
  rest = rest.replace(/^(?:landed|summary|what landed)\s*:\s*/i, "").trim();
  return { landed: rest, stillOpen, nextStep, empty: !rest };
}

function modeFor(label) {
  const name = label.toLowerCase();
  if (name === "still open" || name === "remaining" || name === "left to do") return "stillOpen";
  if (name === "next step" || name === "next") return "nextStep";
  return "landed";
}

function pickString(obj, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const parts = value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
      if (parts.length) return parts.join("; ");
    }
  }
  return "";
}

function asOpen(text) {
  const cleaned = cleanClause(text, 200);
  return cleaned || null;
}

function asAction(text) {
  let action = cleanClause(text, 160);
  action = action.replace(/^i'll\s+/i, "").replace(/^i will\s+/i, "");
  if (!action) return "";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function cleanClause(text, max) {
  let s = scrub(text);
  s = s.replace(/[.!?]+\s+/g, ", ");
  s = s.replace(/[.!?]+$/g, "");
  s = s.replace(/\s+,/g, ",");
  s = s.replace(/,\s*,+/g, ", ");
  s = s.replace(/^[,\s]+|[,\s]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (s.length > max) s = clipWords(s, max);
  return s;
}

function scrub(text) {
  return String(text || "")
    .replace(/want me to/gi, "")
    .replace(/\?/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.])/g, "$1")
    .trim();
}

function sentenceCase(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clipWords(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const base = space > 16 ? cut.slice(0, space) : cut;
  return base.replace(/[,\s:;]+$/g, "").trim();
}

module.exports = { summarizeAgentDone };
