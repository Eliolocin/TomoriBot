---
title: "Setup: Codex CLI via ChatMock"
sidebar:
  order: 5
---

If you want TomoriBot to use your ChatGPT account through a local OpenAI-compatible bridge, you can run [ChatMock](https://github.com/RayBytes/ChatMock) and point TomoriBot's `custom` provider at it.

## What ChatMock does

- ChatMock runs a local OpenAI-compatible API server
- TomoriBot can use that local server through the `custom` provider

## 1. Start ChatMock

Install and start ChatMock by following its instructions on GitHub:

- [ChatMock repository](https://github.com/RayBytes/ChatMock)

After installing, run:
```sh
chatmock login
chatmock serve
```

By default, ChatMock listens on `http://127.0.0.1:8000/v1`

## 2. Configure TomoriBot to use ChatMock

In Discord, configure TomoriBot's `custom` provider and use:

- **Endpoint URL**: `http://127.0.0.1:8000/v1`
- **Model Name**: the exact model string ChatMock should receive, such as `gpt-5.4` or `gpt-5.3-codex`

A bare `http://127.0.0.1:8000` also works: TomoriBot normalizes it to `/v1` before appending `/chat/completions`.

Enable these capability flags for ChatMock:
- **Function Calling / Tools**: Yes
- **Image Understanding**: Yes
- **Video Understanding**: No
- **Structured Output**: Yes

**Note**: Codex CLI does not allow you to change its `system` prompt so TomoriBot's `system` prompt is turned into a `user` turn in context as a workaround. Please configure the `CHATMOCK_PORT` .env variable to match your actual ChatMock port so this workaround works properly (defaults to 8000).