// Two-way voice against an ElevenLabs agent.
//
// One WebSocket carries the whole loop: we stream microphone PCM up, the
// agent streams speech back down, and ElevenLabs handles turn-taking, barge-in
// and the LLM in between. Audio is 16-bit signed PCM, mono, 16kHz, base64 —
// in both directions.
//
// The API key never reaches this file. The main process holds it and hands
// back a short-lived signed URL.

const RATE = 16000;
const CHUNK = 2048;

let ws = null;
let audio = null;
let micStream = null;
let micNode = null;
let processor = null;
let micAnalyser = null;
let outAnalyser = null;
let outGain = null;
let playhead = 0;
let sources = [];
let hooks = {};
let active = false;
let speaking = false;
let levelTimer = null;
let usingMic = true;
let voiceBackend = "elevenlabs"; // or "local"

// ---------- the gate ----------
//
// ElevenLabs has no setting that stops an agent taking a turn on its own —
// turn_timeout caps at 30s and every eagerness mode eventually speaks. So the
// rule is enforced here: he is only allowed to talk if you actually said
// something first, and "something" has to be more than a noise.

let allowSpeech = false;
let suppressTurn = false;
let speakEndTimer = null;
let toolsInFlight = 0;
let intentionalStop = false;
let reconnectAttempts = 0;

// Gap between audio chunks can look like "done speaking" — wait before going idle.
const SPEAK_END_GRACE_MS = 450;

const FILLERS = new Set([
  "uh", "um", "uhm", "hm", "hmm", "mhm", "mm", "mmm", "ah", "eh", "er", "erm",
  "oh", "huh", "hu", "mhmm", "uh huh", "you", "the", "a",
]);

// A transcript worth waking him for: has letters, isn't a lone filler, and
// isn't a single stray character the recogniser invented out of room noise.
function isMeaningful(text) {
  const raw = String(text || "").trim().toLowerCase().replace(/[.,!?;:'"]+/g, "");
  if (!raw) return false;
  if (!/[a-z0-9]/.test(raw)) return false;
  if (raw.length < 2) return false;
  if (FILLERS.has(raw)) return false;
  // Strings made only of fillers, e.g. "uh um".
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => FILLERS.has(w))) return false;
  return true;
}

const micBuf = new Uint8Array(0);

function encodeBase64(bytes) {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(out);
}

function decodeBase64(b64) {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function emit(name, payload) {
  if (typeof hooks[name] === "function") hooks[name](payload);
}

// ---------- playback ----------

function clearSpeakEndTimer() {
  if (speakEndTimer) {
    clearTimeout(speakEndTimer);
    speakEndTimer = null;
  }
}

function scheduleSpeakEnd() {
  clearSpeakEndTimer();
  speakEndTimer = setTimeout(() => {
    speakEndTimer = null;
    if (toolsInFlight > 0) {
      scheduleSpeakEnd();
      return;
    }
    if (!sources.length && speaking) {
      speaking = false;
      allowSpeech = false;
      emit("speakEnd");
    }
  }, SPEAK_END_GRACE_MS);
}

function playChunk(b64, sampleRate) {
  if (!audio) return;
  clearSpeakEndTimer();
  const bytes = decodeBase64(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (!pcm.length) return;

  const rate = sampleRate || RATE;
  const buffer = audio.createBuffer(1, pcm.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;

  const src = audio.createBufferSource();
  src.buffer = buffer;
  src.connect(outGain);

  const now = audio.currentTime;
  const at = Math.max(now + 0.02, playhead);
  src.start(at);
  playhead = at + buffer.duration;

  sources.push(src);
  src.onended = () => {
    sources = sources.filter((s) => s !== src);
    if (!sources.length && speaking) scheduleSpeakEnd();
  };

  if (!speaking) {
    speaking = true;
    emit("speakStart");
  }
}

// The agent got interrupted — drop everything still queued or it talks over
// itself for another second.
function flushPlayback() {
  clearSpeakEndTimer();
  for (const src of sources) {
    try {
      src.stop();
    } catch {
      // already finished
    }
  }
  sources = [];
  playhead = audio ? audio.currentTime : 0;
  if (speaking) {
    speaking = false;
    emit("speakEnd");
  }
}

// ---------- levels, for the face ----------

function rms(analyser, scratch) {
  analyser.getByteTimeDomainData(scratch);
  let sum = 0;
  for (let i = 0; i < scratch.length; i += 1) {
    const v = (scratch[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / scratch.length);
}

function startLevels() {
  const inScratch = new Uint8Array(micAnalyser.fftSize);
  const outScratch = new Uint8Array(outAnalyser.fftSize);
  const tick = () => {
    if (!active) return;
    emit("level", {
      input: Math.min(1, rms(micAnalyser, inScratch) * 5),
      output: Math.min(1, rms(outAnalyser, outScratch) * 6),
      speaking,
    });
    levelTimer = requestAnimationFrame(tick);
  };
  levelTimer = requestAnimationFrame(tick);
}

// ---------- session ----------

// opts.mic:false opens a text-only session — same agent, same voice coming
// back, but no microphone and no permission prompt.
async function start(opts) {
  const wantMic = !opts || opts.mic !== false;
  if (active) {
    // Text-only sessions leave the socket open without a mic. Restart so
    // voice clicks actually hear Jake.
    if (wantMic && !micStream) {
      stop();
    } else {
      return { ok: true, already: true };
    }
  }
  intentionalStop = false;
  reconnectAttempts = 0;
  usingMic = wantMic;
  allowSpeech = false;
  suppressTurn = false;

  const auth = window.workbuddy
    ? await window.workbuddy.voiceSignedUrl()
    : { ok: false, error: "no_api_key" };
  if (!auth || !auth.ok) {
    emit("error", auth && auth.error ? auth.error : "voice_not_configured");
    return { ok: false, error: auth && auth.error };
  }
  voiceBackend = auth.backend === "local" ? "local" : "elevenlabs";

  try {
    if (!wantMic) throw new Error("skip-mic");
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    if (wantMic) {
      emit("error", "mic_denied");
      return { ok: false, error: "mic_denied" };
    }
    micStream = null;
  }

  // Local TTS is 24kHz; ElevenLabs conversational audio is 16kHz.
  const contextRate = voiceBackend === "local" ? 24000 : RATE;
  audio = new AudioContext({ sampleRate: contextRate });
  if (audio.state === "suspended") await audio.resume();

  outGain = audio.createGain();
  outAnalyser = audio.createAnalyser();
  outAnalyser.fftSize = 256;
  outGain.connect(outAnalyser);
  outGain.connect(audio.destination);
  playhead = audio.currentTime;

  micAnalyser = audio.createAnalyser();
  micAnalyser.fftSize = 256;
  if (micStream) {
    micNode = audio.createMediaStreamSource(micStream);
    micNode.connect(micAnalyser);
  }

  await new Promise((resolve, reject) => {
    ws = new WebSocket(auth.url);
    ws.onopen = () => {
      if (voiceBackend === "elevenlabs") {
        ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
      }
      resolve();
    };
    ws.onerror = () => reject(new Error("socket_failed"));
  }).catch((err) => {
    emit("error", "socket_failed");
    throw err;
  });

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (voiceBackend === "local") {
      handleLocalMessage(msg);
      return;
    }

    switch (msg.type) {
      case "audio":
        // Drop the audio for any turn he took without being spoken to.
        if (suppressTurn || !allowSpeech) break;
        if (msg.audio_event && msg.audio_event.audio_base_64) {
          playChunk(msg.audio_event.audio_base_64);
        }
        break;
      case "user_transcript":
        if (msg.user_transcription_event) {
          const heard = msg.user_transcription_event.user_transcript;
          if (isMeaningful(heard)) {
            allowSpeech = true;
            suppressTurn = false;
            emit("heard", heard);
          } else {
            emit("ignored", heard);
          }
        }
        break;
      case "agent_response":
        if (msg.agent_response_event) {
          if (!allowSpeech) {
            // Unprompted — he's filling silence. Swallow it entirely.
            suppressTurn = true;
            emit("suppressed", msg.agent_response_event.agent_response);
          } else {
            suppressTurn = false;
            clearSpeakEndTimer();
            emit("said", msg.agent_response_event.agent_response);
          }
        }
        break;
      case "interruption":
        flushPlayback();
        break;
      case "ping":
        if (msg.ping_event) {
          ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
        }
        break;
      case "client_tool_call":
        handleClientToolCall(msg);
        break;
      case "quota_exceeded":
        emit("error", "quota_exceeded");
        stop();
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    if (intentionalStop) return;
    if (active && voiceBackend === "local" && reconnectAttempts < 2) {
      void softReconnect();
      return;
    }
    stop();
  };

  // ScriptProcessor rather than an AudioWorklet: it needs no separate module
  // fetch (which is fragile under file://) and 16kHz mono is nothing to chew.
  if (micStream) {
    // Always downsample mic to 16k PCM for both backends.
    processor = audio.createScriptProcessor(CHUNK, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const ratio = audio.sampleRate / RATE;
      const outLen = Math.max(1, Math.floor(input.length / ratio));
      const pcm = new Int16Array(outLen);
      for (let i = 0; i < outLen; i += 1) {
        const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const b64 = encodeBase64(new Uint8Array(pcm.buffer));
      if (voiceBackend === "local") {
        ws.send(JSON.stringify({ type: "audio", pcm16_b64: b64 }));
      } else {
        ws.send(JSON.stringify({ user_audio_chunk: b64 }));
      }
    };
    micNode.connect(processor);
    // Chromium won't pump a ScriptProcessor that isn't connected to anything.
    const mute = audio.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(audio.destination);
  }

  active = true;
  startLevels();
  emit("open");
  return { ok: true };
}

function handleLocalMessage(msg) {
  switch (msg.type) {
    case "ready":
      break;
    case "status":
      emit("status", msg);
      break;
    case "user_transcript":
      if (isMeaningful(msg.text)) {
        allowSpeech = true;
        emit("heard", msg.text);
      } else {
        emit("ignored", msg.text);
      }
      break;
    case "agent_response":
      allowSpeech = true;
      clearSpeakEndTimer();
      emit("said", msg.text || "");
      break;
    case "audio":
      allowSpeech = true;
      if (msg.pcm16_b64) playChunk(msg.pcm16_b64, msg.sample_rate || 24000);
      break;
    case "error": {
      const err = String(msg.error || "local_voice_failed");
      // Turn hiccups should not hang up the whole call.
      if (/quota|unauthorized|not_installed|mic_/i.test(err)) {
        emit("error", err);
        stop();
      } else {
        emit("turnError", err);
      }
      break;
    }
    default:
      break;
  }
}

async function softReconnect() {
  reconnectAttempts += 1;
  emit("turnError", "reconnecting");
  emit("status", { state: "thinking", note: "reconnecting" });
  const old = ws;
  if (old) {
    old.onclose = null;
    old.onmessage = null;
    old.onerror = null;
    try {
      old.close();
    } catch {
      // ignore
    }
  }
  ws = null;
  try {
    const auth = window.workbuddy
      ? await window.workbuddy.voiceSignedUrl()
      : { ok: false };
    if (!auth || !auth.ok || auth.backend !== "local") {
      throw new Error("no_local");
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10000);
      ws = new WebSocket(auth.url);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("socket_failed"));
      };
    });
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleLocalMessage(msg);
    };
    ws.onclose = () => {
      if (intentionalStop) return;
      if (active && voiceBackend === "local" && reconnectAttempts < 2) {
        void softReconnect();
        return;
      }
      stop();
    };
    reconnectAttempts = 0;
    emit("status", { state: "listening" });
  } catch {
    stop();
  }
}

function stop() {
  if (!active && !ws) return;
  intentionalStop = true;
  active = false;
  speaking = false;
  clearSpeakEndTimer();

  if (levelTimer) cancelAnimationFrame(levelTimer);
  levelTimer = null;

  flushPlayback();

  if (processor) {
    processor.onaudioprocess = null;
    try {
      processor.disconnect();
    } catch {
      // already gone
    }
  }
  processor = null;

  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  micNode = null;

  if (ws) {
    try {
      if (voiceBackend === "local" && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "end" }));
      }
    } catch {
      // ignore
    }
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already closing
    }
  }
  ws = null;

  if (audio) {
    audio.close().catch(() => {});
  }
  audio = null;

  emit("closed");
}

// Typed input goes down the same socket as speech and runs through the same
// response flow, so the conversation history is shared between the two.
async function sendText(text) {
  const line = String(text || "").trim();
  if (!line) return { ok: false, error: "empty" };

  if (!active) {
    const opened = await start({ mic: false });
    if (!opened.ok) return opened;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, error: "socket_failed" };

  allowSpeech = true;
  suppressTurn = false;
  if (voiceBackend === "local") {
    ws.send(JSON.stringify({ type: "text", text: line }));
  } else {
    ws.send(JSON.stringify({ type: "user_message", text: line }));
  }
  return { ok: true };
}

// Background information for the agent. Unlike a user_message this does not
// trigger a reply — it just lands in his context for whenever it's relevant.
function sendContext(text) {
  const line = String(text || "").trim();
  if (!line || !ws || ws.readyState !== WebSocket.OPEN) return false;
  if (voiceBackend === "local") {
    ws.send(JSON.stringify({ type: "context", text: line }));
  } else {
    ws.send(JSON.stringify({ type: "contextual_update", text: line }));
  }
  return true;
}

async function handleClientToolCall(msg) {
  const call = msg.client_tool_call || msg;
  const toolName = call.tool_name || call.name;
  const toolCallId = call.tool_call_id || call.id;
  const parameters = call.parameters || {};

  const reply = (result, isError) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "client_tool_result",
        tool_call_id: toolCallId,
        result: typeof result === "string" ? result : JSON.stringify(result),
        is_error: Boolean(isError),
      })
    );
  };

  if (!toolName || !toolCallId) {
    reply("invalid client tool call", true);
    return;
  }

  try {
    toolsInFlight += 1;
    clearSpeakEndTimer();
    // Recall tools are named recall_*; route them through Electron → MCP.
    if (String(toolName).startsWith("recall_")) {
      const bridge = window.workbuddy;
      if (!bridge || !bridge.recallTool) {
        reply("Recall bridge unavailable", true);
        return;
      }
      const out = await bridge.recallTool(toolName, parameters);
      if (!out || !out.ok) {
        reply(out && out.error ? out.error : "recall_failed", true);
        return;
      }
      reply(out.text || JSON.stringify(out.data || { ok: true }), Boolean(out.isError));
      emit("tool", { name: toolName, ok: !out.isError });
      return;
    }

    // Cursor planning/research agents Cog can start and continue.
    if (String(toolName).startsWith("cursor_")) {
      const bridge = window.workbuddy;
      const chatTools = {
        cursor_list_chats: "list",
        cursor_search_chats: "search",
        cursor_get_chat: "get",
      };
      if (chatTools[toolName]) {
        if (!bridge || !bridge.cursorChats) {
          reply("Cursor chats bridge unavailable", true);
          return;
        }
        const out = await bridge.cursorChats(chatTools[toolName], parameters);
        if (!out || !out.ok) {
          reply(JSON.stringify(out || { error: "chats_failed" }), true);
          return;
        }
        reply(JSON.stringify(out), false);
        emit("tool", { name: toolName, ok: true });
        return;
      }

      if (!bridge || !bridge.cursorAgent) {
        reply("Cursor agent bridge unavailable", true);
        return;
      }
      const map = {
        cursor_start_agent: "start",
        cursor_continue_agent: "continue",
        cursor_list_agents: "list",
        cursor_running_agents: "running",
        cursor_list_cloud_agents: "list_cloud",
        cursor_agent_status: "status",
        cursor_agent_details: "details",
        cursor_open_agent: "open",
        cursor_stop_agent: "stop",
        cursor_kill_agent: "stop",
        cursor_pause_agent: "pause",
        cursor_restart_agent: "restart",
        cursor_archive_agent: "archive",
        cursor_unarchive_agent: "unarchive",
        cursor_delete_agent: "delete",
      };
      const action = map[toolName];
      if (!action) {
        reply(`unknown cursor tool: ${toolName}`, true);
        return;
      }
      const out = await bridge.cursorAgent(action, parameters);
      if (!out || !out.ok) {
        reply(JSON.stringify(out || { error: "cursor_failed" }), true);
        return;
      }
      reply(JSON.stringify(out), false);
      emit("tool", { name: toolName, ok: true });
      return;
    }

    reply(`unknown client tool: ${toolName}`, true);
  } catch (err) {
    reply(err && err.message ? err.message : "tool_failed", true);
  } finally {
    toolsInFlight = Math.max(0, toolsInFlight - 1);
  }
}

window.CogVoice = {
  init(callbacks) {
    hooks = callbacks || {};
  },
  start,
  stop,
  sendText,
  sendContext,
  isActive: () => active,
  hasMic: () => Boolean(micStream),
  backend: () => voiceBackend,
};
