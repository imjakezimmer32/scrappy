const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");

const server = fs.readFileSync(path.join(__dirname, "../local-voice/server.py"), "utf8");

test("fast path streams tokens instead of waiting for a full reply", () => {
  assert.match(server, /can_stream = stream_before_rewrite/);
  assert.match(server, /async def queue_speech/);
  assert.match(server, /async def flush_speech/);
  assert.match(server, /await self\.queue_speech\(sentence\)/);
});

test("TTS pipelines the next sentence while the current one plays", () => {
  assert.match(server, /class SpeakAhead/);
  assert.match(server, /Synthesize sentence N\+1/);
});

test("talk-lane rewrites are skipped on short casual chat", () => {
  assert.match(server, /skip_talk_rewrites/);
});

test("VAD uses shorter silence on short utterances and speculative Whisper", () => {
  assert.match(server, /silence_needed_ms\(self\.speech_ms\)/);
  assert.match(server, /_maybe_start_speculative/);
  assert.match(server, /SPECULATIVE_MS/);
});
