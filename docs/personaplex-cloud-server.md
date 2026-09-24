# PersonaPlex cloud server (GPU)

Scrappy on your Windows PC does **not** run CUDA. You run **NVIDIA PersonaPlex** (`moshi.server`) on a cloud machine with a GPU, then point Scrappy at it.

## Architecture

```
[Windows PC]  mic/speaker  →  personaplex-bridge (CPU)  →  WSS  →  [Cloud GPU] moshi.server
```

## 1. Cloud box requirements

- NVIDIA GPU (A10/L4/4090 class recommended for real-time 7B duplex)
- Ubuntu 22.04+ (typical on RunPod, Lambda, Vast, etc.)
- Hugging Face account + accept [personaplex-7b-v1 license](https://huggingface.co/nvidia/personaplex-7b-v1)

## 2. Install on the server (one time)

```bash
sudo apt update && sudo apt install -y libopus-dev git python3.12 python3.12-venv
git clone --depth 1 https://github.com/NVIDIA/personaplex.git
cd personaplex
python3.12 -m venv .venv
source .venv/bin/activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -e moshi/
export HF_TOKEN=hf_...
SSL_DIR=$(mktemp -d)
python -m moshi.server --ssl "$SSL_DIR" --host 0.0.0.0 --port 8998
```

Expose **port 8998** (HTTPS/WSS) to the internet — use a **TLS reverse proxy** (Caddy/nginx) with a real certificate in production. For testing, Scrappy’s bridge can skip verify for self-signed certs (dev only).

Note the public URL, e.g. `https://personaplex.yourdomain.com` (no path).

## 3. Scrappy on Windows

1. Voice → **PersonaPlex (cloud GPU)**
2. **Cloud PersonaPlex URL** → `https://personaplex.yourdomain.com`
3. **Install voice bridge on this PC** (small Python venv, no GPU)
4. Save → **Talk to Scrappy**

HF token: set on the **server** (`HF_TOKEN` when starting moshi). You do not need it on the PC unless your host requires client auth (not standard).

## 4. Security

- Use HTTPS and firewall the GPU box to your IP or VPN if possible.
- Do not expose moshi without TLS on the public internet.
- PersonaPlex has no built-in API keys — treat the URL like a secret.

## 5. Detail Solar / receptionist

Put the business role in **Role text prompt** in Scrappy setup. The cloud server loads it on each session. Still no CRM/tools until Scrappy’s work-brain phase wires transcripts to Cursor/Recall.
