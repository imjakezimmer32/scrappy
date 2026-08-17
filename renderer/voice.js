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

// ---------- the gate ----------
//
// ElevenLabs has no setting that stops an agent taking a turn on its own —
// turn_timeout caps at 30s and every eagerness mode eventually speaks. So the
// rule is enforced here: he is only allowed to talk if you actually said
// something first, and "something" has to be more than a noise.

let allowSpeech = false;
let suppressTurn = false;

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

function playChunk(b64) {
  if (!audio) return;
  const bytes = decodeBase64(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (!pcm.length) return;

  const buffer = audio.createBuffer(1, pcm.length, RATE);
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
    if (!sources.length && speaking) {
      speaking = false;
      allowSpeech = false;
      emit("speakEnd");
    }
  };

  if (!speaking) {
    speaking = true;
    emit("speakStart");
  }
}

// The agent got interrupted — drop everything still queued or it talks over
// itself for another second.
function flushPlayback() {
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
    if (wantMic && !micStream) return { ok: true, needsRestart: true };
    return { ok: true, already: true };
  }
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

  // Asking for a 16kHz context makes Chromium resample the mic for us, which
  // is exactly the rate the agent wants in both directions.
  audio = new AudioContext({ sampleRate: RATE });
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
    // If Windows/another app yanks the mic mid-call, this is the only signal
    // we get — without it the session goes silently dead while everything
    // else (LEDs, bubble) still claims he's listening.
    for (const track of micStream.getTracks()) {
      track.addEventListener("ended", () => teardown("mic_lost"));
    }
  }

  await new Promise((resolve, reject) => {
    ws = new WebSocket(auth.url);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
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
      default:
        break;
    }
  };

  // A close we didn't ask for — network blip, ElevenLabs ending the session,
  // anything — used to be indistinguishable from a deliberate hangup. Both
  // called the same stop() and went silently back to idle, so a dropped call
  // looked identical to nothing having happened. Now it says so.
  ws.onclose = () => teardown("dropped");

  // ScriptProcessor rather than an AudioWorklet: it needs no separate module
  // fetch (which is fragile under file://) and 16kHz mono is nothing to chew.
  if (micStream) {
    processor = audio.createScriptProcessor(CHUNK, 1, 1);
    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i += 1) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      ws.send(
        JSON.stringify({
          user_audio_chunk: encodeBase64(new Uint8Array(pcm.buffer)),
        })
      );
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

function teardown(reason) {
  if (!active && !ws) return;
  active = false;
  speaking = false;

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

  emit("closed", { reason: reason || "user" });
}

function stop() {
  teardown("user");
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
  ws.send(JSON.stringify({ type: "user_message", text: line }));
  return { ok: true };
}

// Background information for the agent. Unlike a user_message this does not
// trigger a reply — it just lands in his context for whenever it's relevant.
function sendContext(text) {
  const line = String(text || "").trim();
  if (!line || !ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type: "contextual_update", text: line }));
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
    reply(`unknown client tool: ${toolName}`, true);
  } catch (err) {
    reply(err && err.message ? err.message : "tool_failed", true);
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
};
