# Giving Scrappy a brain and a voice

Scrappy is installed and walking around. Out of the box he can walk, sit, doze, be thrown, and
fetch you when an agent finishes — but he can't hold a conversation until you give him
something to think with.

**This is all done in his own setup panel, not in a config file.** You don't need an agent for
any of it, and you shouldn't hand anyone your API key to do it for you.

## Open the panel

**Right-click Scrappy → Set up Scrappy…**

(Also on the tray icon — click the `^` by the clock, right-click his face.)

Keys you enter there are encrypted against your Windows credential store and saved in your own
user profile, not in the project folder.

## Pick a brain

- **Cloud API** — paste an OpenAI key (or Groq). Fastest to set up, costs money per use.
- **Local (Ollama)** — free, private, runs on your machine. Needs Ollama installed and a
  one-time `npm run setup-local-voice` for the speech stack.

## Pick a voice

- **ElevenLabs** — paste a key, then hit **Build his voice agent** in the panel. That uploads
  his personality and takes a few seconds. Restart him afterwards.
- **Local** — Whisper for ears, Kokoro for mouth. Free and unlimited, less polished.
- **Auto** — local if it's installed, otherwise ElevenLabs.

Leave it alone and he stays text-only. He still works.

## Then

- **Click him** to type at him. This never opens the microphone.
- **Tray → Talk to Scrappy (voice)** for a real conversation with turn-taking and barge-in.
- **Say "hey there Scrappy"** to start hands-free, if you left the wake word on.

Voice is always a deliberate choice, so a stray click can't put a live mic in the room.

## Where things are

- Settings and encrypted keys: `%APPDATA%\scrappy\settings.json`
- An existing `.env.local` still works and is still read — the panel just doesn't write to it,
  so nothing you set by hand gets overwritten.
- An environment variable beats both. The panel will tell you when a key is coming from one,
  and won't pretend it can change it.
