# Local model choices for Cog

## Ready to A/B test (chat models)

| Model | Feel | Good for |
| --- | --- | --- |
| `qwen2.5:14b` | Smarter all-rounder | Best default upgrade from 7B |
| `gemma2:9b` | Clean, natural chat | Comparing tone vs Qwen |

Switch anytime:

```powershell
npm run model:qwen14
npm run model:gemma9
```

Or:

```powershell
powershell -File scripts/switch-local-model.ps1 qwen2.5:14b
powershell -File scripts/switch-local-model.ps1 gemma2:9b
```

Current model is `OLLAMA_MODEL` in `.env.local`.

## Thinking / reasoning models (next tier)

These “think” before answering (slower, smarter on hard problems):

| Model | Approx fit on 7900 XT | Notes |
| --- | --- | --- |
| `deepseek-r1:14b` | Comfortable | Best first thinking model to try |
| `deepseek-r1:32b` | Tight but possible | Stronger reasoning, slower |
| `qwen3:14b` (thinking mode) | Comfortable | Can toggle think on/off in some setups |
| `qwq` / Qwen reasoning variants | Mid–heavy | Pure reasoning focus |

**Not for your PC alone:** full DeepSeek-R1 671B (datacenter only).

### When to use thinking models
- Hard planning, debugging, math, multi-step decisions  
- Not ideal for every casual “hey there Cog” chat (extra latency)

### Suggested path for Jake
1. A/B **Qwen 14B** vs **Gemma 9B** for everyday Cog voice  
2. If you want deeper reasoning later: add **`deepseek-r1:14b`** as a “think hard” mode  
3. Keep ElevenLabs as optional premium voice when credits exist  
