---
title: "Setup: Local LLM"
aiGenerated: false
sidebar:
  order: 1
---

TomoriBot can use any OpenAI-compatible local LLM server for text generation and embeddings.
This guide walks through the process using **Ollama** as an example because it's the easiest to get started with.

Once you've found your footing consider a more flexible server like
[KoboldCPP](https://github.com/LostRuins/koboldcpp) and use open-source models straight from
[Hugging Face](https://huggingface.co), as picking and trying out different community-made models
is half the fun of running your own AI.

:::note[No env vars needed]
Local models are registered through Discord slash commands and stored encrypted in the
database. There's no `.env` setting for them. See the [local endpoints hub](/self-hosting/local-endpoints/).
:::

## 1. Run your model server

Install [Ollama](https://ollama.com). The examples below use Google's **Gemma 4** but anything in [Ollama's library](https://ollama.com/library) works.

### Which size should I pull?

Local models run in your GPU's **VRAM** (the memory built into your graphics card, separate
from your system RAM). Rule of thumb: a model needs at least its **download size** free in
VRAM, plus ~1–2 GB of headroom for the conversation context. Pick the largest Gemma 4 that
fits your card:

| Your GPU VRAM | Best fit | Download (approx.) |
|---|---|---|
| ~8 GB | `gemma4:e2b` | 7.2 GB |
| ~12 GB | `gemma4:12b` | 7.6 GB |
| ~16 GB | `gemma4:12b` (fits fully), or `gemma4:26b` | 7.6 / 18 GB |
| 24 GB+ | `gemma4:26b` or `gemma4:31b` | 18 / 20 GB |

Downloads are Ollama's default-quantization sizes; see the
[model page](https://ollama.com/library/gemma4) for exact figures. Not sure how much VRAM you
have? On Windows: **Task Manager → Performance → GPU**, read "Dedicated GPU memory."

:::tip[Why 26B can beat its size]
`gemma4:26b` is a **Mixture-of-Experts (MoE)** model: it holds many "expert" sub-networks but
activates only ~4B parameters per token. So even though its ~18 GB of weights don't *quite*
fit in 16 GB, the small spill to system RAM barely slows it down unlike a dense model of the
same footprint. That's why it runs happily on many 16 GB cards.
:::

Pull your chosen size and start the server:

```sh
ollama pull gemma4:12b     # swap for the tag that fits your VRAM
ollama serve               # listens on http://127.0.0.1:11434
```

Confirm it's reachable **from the machine TomoriBot runs on**:

```sh
curl http://127.0.0.1:11434/v1/models
```

Note the exact installed tag, as this is the Model Name you'll register:

```sh
ollama list
# NAME              ID            SIZE
# gemma4:12b        a1b2c3d4...   7.6 GB
```

## 2. Register it in Discord

Run **`/provider custom-endpoint add`** (server-wide) or **`/personal custom-endpoint add`**
(just you) with:

| Field | Value for Ollama |
|-------|------------------|
| `endpoint_label` | A name you choose, e.g. `home-ollama` |
| `capability` | `text` |
| `api_style` | `OpenAI-Compatible` (recommended) or `Ollama Native` |
| `endpoint_url` | `http://127.0.0.1:11434/v1` for OpenAI-Compatible · `http://127.0.0.1:11434` for Ollama Native |
| `auth_token` | *(leave blank)* |

:::tip[Pick the URL that matches the API style]
`OpenAI-Compatible` expects the `/v1` root (TomoriBot appends `/chat/completions` itself — do
**not** add it). `Ollama Native` expects the bare root with no `/v1`.
:::

When you submit, a modal opens. Fill in:

- **Model Name (exact API ID):** `gemma4:12b`, the exact tag from `ollama list`.
- **Display Name:** optional; leave blank to reuse the model name.
- **Context Window Override:** optional, **Ollama / KoboldCPP only**. Set this (e.g. `8192`,
  `16384`) to raise Ollama's default `num_ctx`, which is otherwise small enough to truncate
  long TomoriBot context. Leave blank to use the server default.
- **Toggles:** enable **Tools** if the model supports function calling; enable **Image
  Understanding** only for a vision model; **Structured Output** if the model handles JSON
  schemas well. For our example, Gemma 4 supports all of them, so tick them all.

TomoriBot validates the connection on submit. If it reports the endpoint is unreachable, the
usual cause is a `localhost`/Docker mismatch or a missing/extra `/v1` (see
[gotchas](#notes--gotchas)).

Registering it makes it the active `text` model automatically — start chatting to try it. If
it isn't active for some reason, run `/model text` and select your newly registered model.

Registering never changes any model other than `text`. If you ticked **Image Understanding**
so this endpoint can act as the vision helper for an image-blind chat model, select it
explicitly with `/model vision`; every text endpoint you registered with that toggle on shows
up there. Note the vision model is only consulted when the chat model cannot see images, so
setting one behind a vision-capable chat model has no effect until you switch.

## 3. (Optional) Local embeddings for RAG

Repeat step 2 with `capability: embedding` and an embedding model (e.g.
`ollama pull nomic-embed-text`, Model Name `nomic-embed-text:latest`). RAG features also need
pgvector installed in Postgres. You can see the [manual setup](/self-hosting/manual-setup/) guide here.

## Other servers

All of these use the same flow, only the URL and a couple of notes change.

### KoboldCPP

- Start with OpenAI-compat enabled (built in). Default: `http://127.0.0.1:5001/v1`.
- `api_style`: `OpenAI-Compatible`. `endpoint_url`: `http://127.0.0.1:5001/v1`.
- Honors the **Context Window Override** like Ollama.
- Loads GGUF models; the Model Name is whatever the loaded model reports (often the file
  stem), check KoboldCPP's `/v1/models` response.

### llama.cpp (`llama-server`)

- Build or install [llama.cpp](https://github.com/ggml-org/llama.cpp), then serve a GGUF with
  its bundled OpenAI-compatible server:
  ```sh
  llama-server -m model.gguf -c 16384 --host 0.0.0.0 --port 8080
  ```
- `api_style`: `OpenAI-Compatible`. `endpoint_url`: `http://127.0.0.1:8080/v1`.
- Set the context window at launch with `-c` which is the modal's **Context Window Override** is
  Ollama/KoboldCPP-only and has no effect here.
- Model Name is whatever `/v1/models` reports; give it a clean one with `--alias my-model`.
- If you started it with `--api-key`, put that key in `auth_token`.

### LM Studio

- In LM Studio, start the **Local Server** (Developer tab). Default: `http://127.0.0.1:1234/v1`.
- `api_style`: `OpenAI-Compatible`. `endpoint_url`: `http://127.0.0.1:1234/v1`.
- Model Name is the identifier LM Studio shows for the loaded model.

### vLLM

- Serve with the OpenAI-compatible server: `vllm serve <model>` → `http://127.0.0.1:8000/v1`.
- `api_style`: `OpenAI-Compatible`. `endpoint_url`: `http://127.0.0.1:8000/v1`.
- If you launched vLLM with `--api-key`, put that key in `auth_token`.
- Model Name is the served model path/name (matches `/v1/models`).

### LiteLLM (proxy over many backends)

- Run the LiteLLM proxy; default: `http://127.0.0.1:4000/v1`.
- `api_style`: `OpenAI-Compatible`. `endpoint_url`: `http://127.0.0.1:4000/v1`.
- Model Name is the model alias you defined in LiteLLM's config.
- If the proxy enforces a master key, set it in `auth_token`.

### ChatMock (ChatGPT account / Codex CLI)

Has its own dedicated guide because of a system-prompt workaround:
**[Setup: ChatMock](/self-hosting/local-endpoints/setup-chatmock/)**.

## Picking models from Hugging Face

Beyond Ollama's curated library, [Hugging Face](https://huggingface.co) hosts thousands of
community models. KoboldCPP, llama.cpp, and LM Studio can all load the **GGUF** format which is a
single-file package you download and point the server at.

1. **Find a GGUF.** Search Hugging Face for your model plus "GGUF" community quantizers like
   [bartowski](https://huggingface.co/bartowski) publish GGUF builds of most popular models
   soon after release. Prefer an **instruct/chat** variant (names ending in `-Instruct` or
   `-Chat`); base models don't hold a conversation.
2. **Pick a quant that fits your VRAM.** A repo lists the same model at many quant levels, and a
   file's size ≈ the VRAM it needs (plus ~1–2 GB for context, same rule as the
   [sizing table](#which-size-should-i-pull) above). Download the single `.gguf` for your choice.
3. **Load it.** Start KoboldCPP or `llama-server` with that file (see
   [Other servers](#other-servers)), then register the endpoint in Discord as usual.

:::tip[Which quant? Q4 or Q5 is the sweet spot]
**Quantization** stores each weight in fewer bits to shrink the model, at a small quality cost.
The code in names like `Q4_K_M` / `Q5_K_M` is the bits-per-weight: **4-bit (Q4) or 5-bit (Q5)
is the usual sweet spot** as most of the quality for roughly half the size of 8-bit. Below 4-bit
degrades quickly. And for a fixed VRAM budget, a **larger model at Q4 usually beats a smaller
model at Q8**.
:::

## Notes & gotchas

- **One connection per label.** To register several models that share one server, reuse the
  same `endpoint_label` + `capability`; the URL and API style are inherited and you only set
  a new Model Name. Use distinct labels for genuinely different servers.
- **Display Name vs Model Name.** Display Name is cosmetic (what you see in `/model`); Model
  Name is the exact string sent to the server. Getting the Model Name wrong is the most
  common "it connected but responses fail" cause.
- **Running TomoriBot in Docker?** `localhost` inside the container is not your host. Use
  `http://host.docker.internal:<port>` (Windows/macOS) or the host's LAN IP, and bind the
  model server to `0.0.0.0`.
