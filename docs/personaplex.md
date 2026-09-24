# PersonaPlex in Scrappy (cloud)

[NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex) is Scrappy’s **full-duplex** voice: listen and talk at the same time (backchannels, barge-in).

**Your PC does not run CUDA.** Only a small **bridge** runs locally; the 7B model runs on a **cloud GPU** you operate.

## Quick setup

| Where | What |
|--------|------|
| **Cloud GPU** | `moshi.server` — see [personaplex-cloud-server.md](./personaplex-cloud-server.md) |
| **Windows PC** | Scrappy + **Install voice bridge** + **Cloud PersonaPlex URL** in setup |

## Hybrid with Scrappy

| Layer | Where |
|--------|--------|
| Duplex speech | Cloud PersonaPlex |
| Persona / role | `personality.md` + **Role text prompt** in setup |
| Tools (Cursor, Recall, agents) | Local **work sidecar** (Whisper + executive) — same brain as local voice, no Kokoro |

## Setup panel

1. **His voice → PersonaPlex (cloud GPU)**
2. **Cloud PersonaPlex URL** — required (`https://your-host:8998` or proxied URL)
3. **Install voice bridge on this PC** — once, no GPU
4. Optional: voice file (`NATM1.pt`), role prompt (e.g. Detail Solar receptionist)
5. Save → **Talk to Scrappy**

## Ports on your PC

| Service | Port |
|---------|------|
| Bridge (local) | 8792 |

Cloud server: **8998** (default moshi HTTPS).

## Licenses

PersonaPlex code: MIT. Weights: NVIDIA Open Model License.
