---
title: "Image Generation"
sidebar:
  order: 1
---

TomoriBot can generate images from a text prompt or by editing a reference image. Use
`/generate image`, or just ask her ("draw me a red panda drinking coffee").

## What She Can Do

- **Text-to-image** — generate from a prompt.
- **Image-to-image** — edit or restyle a whole reference image.
- **Inpainting** — redraw a specific region while preserving the rest.
- **Outpainting** — extend the canvas beyond the original frame.
- **Customizable aspect ratios**.
- **Reference images** can come from message attachments, stickers, emojis, or user/persona
  avatars. Point her at a message, or name a user/persona to pull in their avatar as a
  reference.

Which editing modes are available depends on the backend. Text-to-image and image-to-image
work on the built-in cloud providers (Google, Vertex, OpenRouter), while **inpainting and
outpainting are provided by local [ComfyUI](/self-hosting/local-endpoints/setup-comfyui/)
custom endpoints** and are gated by that endpoint's declared capabilities. Whatever the
backend can't do is simply hidden from her, so she won't offer a mode your setup doesn't
support.

When she generates an image, she uses your persona's Physical Appearance context plus default
positive and negative tags (where the backend supports negative prompts). The result is
delivered as a Discord media gallery with generation-time details, including any referenced
users or personas.

## Tag Customization

Every tag source above is editable, each at a different scope. All of these open a modal
pre-filled with the current tags, so you edit in place:

- **`/config` > Persona > Appearance** — the selected persona's **Physical Appearance** tags (how *she*
  looks). Requires the Manage Server permission.
- **`/personal config`** — *your own* appearance tags, applied when a generation
  references you. Follows you across every server (see
  [Personalization](/features/knowledge/personalization/)).
- **Default positive and negative tags** on **`/config` > Models > Image Generation** —
  the server-wide default tags added to (or steered away from) every generation. Negative
  tags only take effect where the backend supports negative prompts. Submitting the modal with
  an empty box resets that list to the built-in defaults.

## Setup

1. Configure an image model with `/config` > Models > Switch Models.
2. Make sure image generation is allowed — it's gated by the `imagegen_enabled` capability
   (`/config` > Permissions).
3. Ask her to generate, or run `/generate image`.

## Provider Support

Native image generation is available on **Google, Vertex AI, Vertex AI Express, OpenRouter,
Z.ai, NVIDIA NIM**, and **NovelAI** (anime-styled; native inpainting is built and coming
soon, currently disabled while edge-blending is refined). For the full support
matrix and how to add a provider, see
[Providers & Models](/features/setup-administration/providers-and-models/#supported-providers).

For **local** image generation with your own hardware via ComfyUI, see
[Setup: ComfyUI](/self-hosting/local-endpoints/setup-comfyui/).
