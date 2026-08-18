// The setup panel. Reads the current state, shows only the fields that matter
// for the chosen backend, and writes back on save.
//
// Secrets are write-only from here: the panel is told whether a key is set, not
// what it is. An empty key box therefore means "leave it alone", not "delete
// it" — clearing is an explicit button, so a stray save can't wipe your key.

const TEXT_FIELDS = [
  "SCRAPPY_USER_NAME",
  "SCRAPPY_LLM_MODEL",
  "OLLAMA_MODEL",
  "OLLAMA_THINK_MODEL",
];

const SECRET_FIELDS = [
  "OPENAI_API_KEY",
  "GROQ_API_KEY",
  "ELEVENLABS_API_KEY",
  "CURSOR_API_KEY",
];

const statusEl = document.getElementById("status");
let saveTimer = null;

function say(text, tone = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${tone}`;
  clearTimeout(saveTimer);
  if (text) saveTimer = setTimeout(() => (statusEl.textContent = ""), 3200);
}

function radio(name) {
  const on = document.querySelector(`input[name="${name}"]:checked`);
  return on ? on.value : "";
}

function setRadio(name, value) {
  const match = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (match) match.checked = true;
}

// Show the groups that belong to the current choices. A group can list several
// values ("elevenlabs auto") because a key is worth collecting for both.
function syncVisibility() {
  const brain = radio("brain");
  const voice = radio("voice");
  for (const group of document.querySelectorAll("[data-when-brain]")) {
    group.hidden = !group.dataset.whenBrain.split(" ").includes(brain);
  }
  for (const group of document.querySelectorAll("[data-when-voice]")) {
    group.hidden = !group.dataset.whenVoice.split(" ").includes(voice);
  }
}

function applyState(state) {
  for (const key of TEXT_FIELDS) {
    const input = document.getElementById(key);
    if (input) input.value = state.values[key] || "";
  }
  // Names default to the OS account, and that default is worth showing rather
  // than leaving the box blank and mysterious.
  const nameInput = document.getElementById("SCRAPPY_USER_NAME");
  if (nameInput && !nameInput.value) nameInput.placeholder = state.userName || "you";

  const brain = (state.values.SCRAPPY_LLM_BACKEND || "cloud").toLowerCase();
  setRadio("brain", brain === "ollama" || brain === "local" ? "ollama" : "cloud");
  setRadio("voice", (state.values.VOICE_BACKEND || "auto").toLowerCase());

  const wake = document.getElementById("SCRAPPY_WAKE_WORD");
  const wakeRaw = String(state.values.SCRAPPY_WAKE_WORD || "on").toLowerCase();
  wake.checked = !(wakeRaw === "off" || wakeRaw === "false" || wakeRaw === "0");

  for (const key of SECRET_FIELDS) {
    const input = document.getElementById(key);
    if (!input) continue;
    input.value = "";
    markSecret(input, state.secrets[key], state.sources[key]);
  }

  document.getElementById("warning").hidden = state.encryptionAvailable !== false;
  syncVisibility();
}

// A key that came from an environment variable can't be changed from here —
// env wins over the store, so saving would look like it worked and silently do
// nothing. Better to say so.
function markSecret(input, isSet, source) {
  const field = input.closest(".field");
  let note = field.querySelector(".saved");
  if (!note) {
    note = document.createElement("span");
    note.className = "saved";
    field.appendChild(note);
  }
  if (source === "environment") {
    note.textContent = "set by an environment variable — change it there";
    input.disabled = true;
    return;
  }
  input.disabled = false;
  if (isSet) {
    note.innerHTML = 'saved — type to replace, or <button type="button" class="link">remove</button>';
    note.querySelector("button").addEventListener("click", async () => {
      const result = await window.setup.clearSecret(input.id);
      if (result.ok) {
        applyState(result.state);
        say("Removed.", "ok");
      }
    });
  } else {
    note.textContent = source === ".env.local" ? "found in .env.local" : "";
  }
}

function collect() {
  const patch = {};
  for (const key of TEXT_FIELDS) {
    const input = document.getElementById(key);
    if (input) patch[key] = input.value.trim();
  }
  patch.SCRAPPY_LLM_BACKEND = radio("brain");
  patch.VOICE_BACKEND = radio("voice");
  patch.SCRAPPY_WAKE_WORD = document.getElementById("SCRAPPY_WAKE_WORD").checked ? "on" : "off";

  // Only send a secret when something was actually typed. Sending "" would
  // clear a key every time someone opened the panel and hit save.
  for (const key of SECRET_FIELDS) {
    const input = document.getElementById(key);
    if (input && !input.disabled && input.value.trim()) patch[key] = input.value.trim();
  }
  return patch;
}

for (const input of document.querySelectorAll('input[type="radio"]')) {
  input.addEventListener("change", syncVisibility);
}

document.getElementById("build-voice").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const out = document.getElementById("build-output");
  button.disabled = true;
  button.textContent = "Building…";
  out.hidden = true;

  const result = await window.setup.buildVoice();

  button.disabled = false;
  button.textContent = "Build his voice agent";
  if (result.ok) {
    if (result.state) applyState(result.state);
    say("Voice agent built. Restart Scrappy.", "ok");
    return;
  }
  if (result.error === "no_key") {
    say("Save an ElevenLabs key first.", "bad");
    return;
  }
  say("That didn't work.", "bad");
  out.textContent = result.output || "No output.";
  out.hidden = false;
});

document.getElementById("close").addEventListener("click", () => {
  window.setup.close();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.setup.close();
});

document.getElementById("save").addEventListener("click", async () => {
  const result = await window.setup.write(collect());
  if (!result || !result.ok) {
    say("Couldn't save. Check the console.", "bad");
    return;
  }
  applyState(result.state);
  say("Saved. Restart Scrappy for voice changes to take.", "ok");
});

window.setup
  .read()
  .then(applyState)
  .catch(() => say("Couldn't read your settings.", "bad"));
