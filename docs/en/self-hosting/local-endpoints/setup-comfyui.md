---
title: "Setup: ComfyUI"
aiGenerated: false
sidebar:
  order: 2
---

TomoriBot can generate images and videos through your own
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance. It drives ComfyUI by
submitting an **API-format workflow** with your prompt/size substituted in, then polls
ComfyUI's `/history` endpoint until the output is ready.

This guide covers installing/running ComfyUI and registering it. For **authoring or editing**
a TomoriBot-compatible workflow (the `{TOMORI_*}` placeholders), use the in-Discord deep
dive, open `/help`, choose **Features**, then **Custom Endpoints**, and use the
[workflow README](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows)
on GitHub.

:::note[No env vars needed]
ComfyUI is registered through Discord slash commands and stored encrypted in the database.
See the [local endpoints hub](/self-hosting/local-endpoints/).
:::

## Hardware requirements

Image and video generation is **GPU-bound**: the heavy cost is **VRAM** (your graphics card's
memory, separate from system RAM), set by the model checkpoint your workflow loads, not by
ComfyUI itself. An NVIDIA GPU is strongly recommended. The two workflows TomoriBot ships are
both modern, heavier-than-SDXL models:

| Bundled workflow | Base model | Practical VRAM | Notes |
|---|---|---|---|
| **Anima v1** (image) | Qwen-Image (~20B), fp8 | ~16 GB floor · 24 GB comfortable | Text encoder + VAE add ~8–10 GB of overhead. Below 16 GB, use a GGUF build + `--lowvram`. |
| **WAN i2v loop** (video) | Wan 2.2 14B, fp8 + 4-step LightX2V LoRAs | ~16 GB workable · 24 GB+ comfortable | Heaviest option expect **minutes per clip**. Offload the UMT5 text encoder to RAM (`t5_cpu`, needs 24 GB+ system RAM) on smaller cards. |

Both bundled checkpoints are already **fp8-quantized** to fit consumer cards. If you have less
VRAM, swap the UNET for a smaller quant and enable ComfyUI's `--lowvram` / CPU offload. CPU-only diffusion is
impractical (many minutes per image, worse for video) and can exceed TomoriBot's poll window,
so a GPU is effectively required for regular use.

:::tip[Going lower: pick a GGUF quant]
**Quantization** stores each model weight in fewer bits to cut VRAM and disk use, at a small
precision cost. The bundled fp8 files are a mild form of it, and to shrink further, download a
**GGUF** build of the model from Hugging Face: the code in names like `Q4_K_M` / `Q5_K_M` is the
bits-per-weight, and **4-bit (Q4) or 5-bit (Q5) is the usual sweet spot** with most of the quality
for a fraction of the fp8/fp16 footprint. Below 4-bit shrinks more but degrades quickly. Loading
GGUF UNETs in ComfyUI needs the [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) custom
node.
:::


## 1. Run ComfyUI with the API enabled

Install ComfyUI per [its README](https://github.com/comfyanonymous/ComfyUI) and start it so it
listens on the network:

```sh
python main.py --listen 0.0.0.0 --port 8188
```

`--listen 0.0.0.0` matters if TomoriBot runs in Docker or on a different machine — the
default binds to loopback only. Confirm reachability **from the machine the bot runs on**:

```sh
curl http://127.0.0.1:8188/system_stats
```

If you want to test, load the model checkpoints your chosen workflow expects and do one manual generation in the
ComfyUI web UI to confirm it works end to end before wiring up TomoriBot.

## 2. Grab a TomoriBot workflow

Download a ready-to-use **API-format** workflow. Examples can be found in the repo under
[`assets/comfyui-workflows/`](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows):

| Workflow | Modes |
|----------|-------|
| Anima v1 (image) : `tomoribot-anima-v1-comfyui.json` | `txt2img`, `img2img`, `inpaint` |
| WAN i2v loop (video) : `tomoribot-wan-i2v-loop-video.json` | image-to-video |

These are **API format** (the JSON ComfyUI exports via *Save (API Format)*), not the regular
UI-save format. If you author your own, it must contain the `{TOMORI_*}` placeholders
TomoriBot substitutes (prompt, width/height, seed, reference images, etc.). See the workflow
README and the **Custom Endpoints** page under **Providers** in `/help`.

## 3. Register it in Discord

Run **`/providers`** (or `/personal providers`), choose **Add New Custom Endpoint**, and enter:

| Field | Value for ComfyUI |
|-------|-------------------|
| `endpoint_label` | A name you choose, e.g. `home-comfy` |
| API Compatibility | `ComfyUI` |
| `endpoint_url` | `http://127.0.0.1:8188` (root, **no** `/v1`) |
| `auth_token` | *(leave blank unless your ComfyUI is behind auth)* |

After saving the connection, select it and use its model dropdown to add an Image or Video
model. Enter the checkpoint's exact code name and **upload the workflow `.json`** you downloaded
from Step 2. The model capability must match the workflow (image workflow → `image`, video
workflow → `video`).

An image model also asks for its **Image Capabilities**: text to image, reference image,
inpainting, and negative prompt. Tick only the modes your workflow actually implements, because
Tomori offers the tool only the modes you declare. Inpainting appears for ComfyUI connections
only, since no other API compatibility accepts a mask. Editing the model later reopens the form
with your current selection, so changing a code name will not clear it.

Adding the model makes it the active `image`/`video` model automatically. Trigger generation by asking Tomori directly in chat. If it isn't active for some reason, run `/model image` (or `/model video`)
and select your registered ComfyUI endpoint.

## Troubleshooting

- **Unreachable on add:** ComfyUI bound to loopback while the bot is in Docker / on another
  host. Start it with `--listen 0.0.0.0` and use `http://host.docker.internal:8188` or the
  LAN IP.
- **Generation never completes:** TomoriBot polls `/history` until the output appears. Cold
  starts and large models on CPU can exceed the poll window.
- **Prompt/size ignored or wrong output size:** the workflow is missing the required
  `{TOMORI_*}` placeholders, or you uploaded a UI-format export instead of API format.
- **Wrong capability:** an `image` workflow registered under `video` (or vice-versa) won't
  run. Re-add it under the matching capability.
