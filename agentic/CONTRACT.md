# Agentic module contract

Each module is pure logic. No Electron, no network, no Cursor SDK.
Tests live in `test/agentic-<module>.test.js` using `node:test` and `node:assert/strict`.
Do not edit `main.js`, `personality.md`, `renderer/scrappy.js`, or another module's files.
Persistence goes through `agentic/store.js` only when the module must remember something.
User-facing copy is short, spoken, and sounds like Scrappy (a small robot). No "Want me to".
