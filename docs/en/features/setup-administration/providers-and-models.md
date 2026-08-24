---
title: "Providers & Models"
sidebar:
  order: 1
---

TomoriBot doesn't have a built-in AI model, you connect one from a provider. A **provider** is an AI
service (Google Gemini, OpenRouter, NovelAI, a local endpoint, …), and a **model** is a
specific model on that provider. You need at least one provider to use her at all.

## API Keys

Add a provider key during first-time setup with `/setup`, or later from `/providers` by choosing
**Add New Provider**. Keys are **encrypted at rest** — no one, including server admins, can read
them back.

Each provider has its own key-generation steps. Run **`/help`**, choose **Setup**, then **Step 1: Get an API Key**, and pick your
provider for the exact walkthrough, or use these starting points:

| Provider | Notes | Get a key |
|---|---|---|
| **Google Gemini** | Free tier, runs every feature. Recommended first setup. | [AI Studio](https://aistudio.google.com/apikey) |
| **OpenRouter** | One key, many models (some free). | [OpenRouter keys](https://openrouter.ai/settings/keys) |
| **NovelAI** | Subscription; uncensored storytelling/roleplay (text only). | [NovelAI](https://novelai.net/) |
| **DeepSeek** | Pay-as-you-go reasoning models. | [DeepSeek](https://platform.deepseek.com/api_keys) |
| **NVIDIA NIM** | Hosted text, embeddings, and image. | [NVIDIA Build](https://build.nvidia.com/) |
| **Anthropic** | Claude models via the API (not Claude Code). | — |
| **Z.ai** | GLM family. ⚠️ ToS restricts usage to coding/agent scenarios. | [Z.ai](https://z.ai/) |
| **Vertex AI** | Google Cloud via `gcloud` ADC — best for locally-run/dev setups. | see below |
| **Vertex AI Express** | Google Cloud API-key BYOK (Preview, Gemini subset). | [Express Mode](https://console.cloud.google.com/expressmode) |
| **Custom** | Any OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, …). | see [Custom Endpoints](#custom-endpoints) |

:::caution
Never share your API key with anyone else. Add or replace a custom endpoint's Bearer auth token from its
**Edit Endpoint** action in `/providers`.
:::

**Vertex AI** authenticates with Application Default Credentials rather than a stored secret.
For local hosting, ADC can come from `gcloud`; hosted deployments should use a workload identity
or service account. An AI Studio API key alone does not authenticate full Vertex AI. The selected
project must have billing and the Vertex AI API enabled, and the host identity needs Vertex access.
The setup guide is available from **Google Vertex AI** on the **API Keys** page in `/help`.

Google-backed provider setup validates credentials through the authenticated model-listing
endpoint. It does not generate text or depend on whichever chat model is currently marked as
the catalog default, so a retired default cannot prevent a valid credential from being saved.

### Optional: Brave Search key

Brave Search is separate from your AI provider and only enhances web search (adds image,
video, and news search). Set it with `/providers`. ⚠️ Brave includes $5/month
free credit — set a $5 usage limit in the Brave dashboard to avoid charges.

## Choosing Models

`/providers` manages server credentials and model catalogs, while `/model` selects the shared
defaults every member of this server uses. Both need the required server permission. Individual
members manage their own credentials and catalogs with `/personal providers`, then select personal
models with the `/personal provider model-*` commands. Personal settings follow them across every
server where they use TomoriBot. See
[Personalization](/features/knowledge/personalization/#your-own-providers) for that side.

The panels are titled **Server Providers** and **Personal Providers** so their ownership remains visible after
the command interaction opens.

After a provider is set, pick which model each capability uses for this server:

- `/model text` — the main chat model
- `/model vision` — a vision model (for reading images when the chat model can't)
- `/model image` — image generation (see [Image Generation](/features/capabilities/media-generation/image-generation/))
- `/model video` — video generation
- `/model embedding` — embeddings for the [document knowledge base](/features/knowledge/memory/#document-knowledge-base-rag)
- `/model speech` / `/model transcription` — [voice](/features/capabilities/media-generation/tts-and-stt/)

You can also manage this server's backup keys for automatic failover and load balancing with
`/providers`.

## Custom Endpoints

Custom endpoints let you register self-hosted or proxy-backed services — Ollama, LM Studio,
LiteLLM, vLLM, ComfyUI, local TTS/STT — as **labeled provider bundles**.

- **Server scope:** open `/providers`.
- **Personal scope:** open `/personal providers` (just you — see
  [Personalization](/features/knowledge/personalization/#your-own-providers)).

A **label** is the user-facing menu name and groups capabilities under one bundle when they share
one endpoint URL. It is never sent to the remote endpoint. Capabilities served from different URLs
need distinct labels. Choose **Add New Custom Endpoint**, select the
API compatibility, and save the connection. Saving prepares the capabilities supported by that
protocol without registering any models. Then select the new endpoint, choose **Add or Edit a
Model**, and register its exact model code and capability. Adding a model activates it for that
capability. Use the same model action to attach more models or edit a workspace-added registration.
Text models declare their own capabilities in that form, and image models declare which request modes
they support.

API compatibility determines the request paths and payloads the service implements, so it also determines which
capability slots the connection prepares. Registering exact models for those slots is a separate step, and the
protocol cannot be inferred reliably from the endpoint URL.

For full walkthroughs of running the servers, see:

- [Setup: Local LLM](/self-hosting/local-endpoints/setup-local-llm/) — Ollama, KoboldCPP, LM Studio, vLLM, LiteLLM.
- [Setup: ComfyUI](/self-hosting/local-endpoints/setup-comfyui/) — local image/video generation.
- [Setup: ChatMock](/self-hosting/local-endpoints/setup-chatmock/) — ChatGPT account / Codex CLI.

## Supported Providers

If you don't have the hardware to host your own models, TomoriBot supports a wide range of
services. Not every feature is available on every provider.

### LLM Providers

| Provider | Streaming | Tool Calling | Image Input | Embeddings | Notes |
|---|---|---|---|---|---|
| **Google Gemini** | ✅ | ✅ | ✅ | ✅ | Free models available |
| **OpenRouter** | ✅ | ✅ | ✅ | ✅ | Free models available |
| **Anthropic (API)** | ✅ | ✅ | ✅ | – | Not Claude Code |
| **NovelAI** | ✅ | ✅ | – | – | Only GLM 4.6 can use tools |
| **NVIDIA NIM** | ✅ | ✅ | ✅ | ✅ | Free models available |
| **DeepSeek** | ✅ | ✅ | – | – | – |
| **Z.ai** | ✅ | ✅ | ✅ | – | Free models; ⚠️ ToS = coding/agent use only |
| **Z.ai Coding** | ✅ | ✅ | – | – | Subscription plan |
| **Google Vertex AI** | ✅ | ✅ | ✅ | ✅ | Includes 'free' Express version |
| **Codex CLI (via ChatMock)** | ✅ | ✅ | ✅ | – | [Setup](/self-hosting/local-endpoints/setup-chatmock/) |

### Image Generation

| Provider | Text-to-Image | Image-to-Image | Inpainting | Notes |
|---|---|---|---|---|
| **Google** | ✅ | ✅ | – | – |
| **OpenRouter** | ✅ | ✅ | – | – |
| **NovelAI** | ✅ | ✅ | ✅ | Can combine with other providers |
| **NVIDIA** | ✅ | – | – | Text-to-image only; reference images are ignored |
| **Z.ai** | ✅ | – | – | – |

These are the **defaults** a provider's image models start from, and NovelAI runs through its own pipeline
rather than this table. Registering an image model through `/providers` lets you declare that model's own
modes, which is how you enable inpainting on a ComfyUI workflow or on a provider model whose API supports
masked editing. A model you never declare keeps following the defaults above, so a later correction to them
reaches it automatically. Declare only what the model really does: Tomori offers the tool exactly the modes
you tick, and a mode the API rejects becomes a failed generation.

### Video Generation

| Provider | Text-to-Video | Image-to-Video | Notes |
|---|---|---|---|
| **Google** | ✅ | ✅ | Async polling workflow |
| **OpenRouter** | ✅ | ✅ | Async polling workflow |
| **Z.ai** | ✅ | ✅ | Async polling workflow |

### Voice & Audio

| Provider | Text-to-Speech | Speech-to-Text |
|---|---|---|
| **ElevenLabs** | ✅ | ✅ |

Local voice engines are covered under [Self-Hosting](/self-hosting/). For the built-in web
search and URL-fetch engines, see [Tools & Extensions](/features/capabilities/tools-and-extensions/#web-search--url-reading).
