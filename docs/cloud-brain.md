# Cloud brain for Cog

Your PC still does **listening** (Whisper) and **speaking** (Kokoro).
The heavy “thinking” part can run on a **cloud API** so your GPU/RAM stay free.

## Quality rule

Prefer a strong model. Do not default to the cheapest/fastest option when
building Cog — Jake wants careful settings.

## Setup (OpenAI — recommended)

1. Get a key: https://platform.openai.com/api-keys  
2. Open `workbuddy/.env.local`  
3. Add:

```
COG_LLM_BACKEND=cloud
COG_LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-your-key-here
```

4. Restart Cog (or tray → **Switch brain → Cloud API**)

`gpt-4o` is the quality default. `gpt-4o-mini` is only for temporary cost saving
if Jake explicitly asks for it.

## Free/fast alternative (Groq)

```
COG_LLM_BACKEND=cloud
COG_LLM_MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=gsk-your-key-here
```

Get a key: https://console.groq.com/keys

## Local light fallback

If no API key is set, Cog automatically uses **Qwen 2.5 7B** locally (much lighter than 14B).

Tray → **Switch brain → Local light (qwen 7B)** forces local.

## What stays on your PC

- Wake word  
- Microphone / Whisper STT  
- Kokoro TTS  
- Recall memory + process journal tools  

Only the chat brain goes to the cloud.
