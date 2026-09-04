---
title: "Video Generation"
sidebar:
  order: 2
---

TomoriBot can generate short videos from a text prompt or by animating a reference image.
Use `/generate video`, or just ask her.

## What She Can Do

- **Text-to-video** — generate a short clip from a prompt.
- **Image-to-video** — animate a reference image (the first image from a referenced message
  becomes the starting frame).
- **Looping image-to-video** — when requested through chat, supported models can reuse the
  starting image as the final frame.
- **Customizable aspect ratios**.

Image-to-video and looping depend on the selected model's first/last-frame capabilities. TomoriBot
checks OpenRouter's current video-model catalog before submitting a paid job and asks you to remove
the image, disable looping, or select a compatible model when necessary.

Video generation uses an **asynchronous polling workflow**: the request is submitted, then
TomoriBot polls the provider until the finished clip is ready, and posts it when done. Large
clips can take a while.

## Setup

1. Configure a video model with `/config` > Models > Switch Models.
2. Ensure image/media generation is permitted via `/config` > Permissions.
3. Ask her to generate, or run `/generate video`.

## Provider Support

Native video generation is available on **Google, OpenRouter**, and **Z.ai**. See the full
matrix in [Providers & Models](/features/setup-administration/providers-and-models/#supported-providers).

For **local** video generation via ComfyUI (e.g. WAN image-to-video workflows), see
[Setup: ComfyUI](/self-hosting/local-endpoints/setup-comfyui/).

For the internal generation and polling architecture, see the reference on
[video generation](/architecture/subsystems/video-generation/).
