---
title: "セットアップ: ChatMock経由のCodex CLI"
sidebar:
  order: 5
---

ローカルのOpenAI互換ブリッジを介してTomoriBotにChatGPTアカウントを使用させたい場合は、[ChatMock](https://github.com/RayBytes/ChatMock)を実行し、TomoriBotの`custom`プロバイダーをそこに向けることができます。

## ChatMockの機能

- ChatMockはローカルのOpenAI互換APIサーバーを実行します。
- TomoriBotは`custom`プロバイダーを通じてそのローカルサーバーを使用できます。

## 1. ChatMockを起動する

GitHubの指示に従ってChatMockをインストールし、起動します。

- [ChatMockリポジトリ](https://github.com/RayBytes/ChatMock)

インストール後、以下を実行します。
```sh
chatmock login
chatmock serve
```

デフォルトでは、ChatMockは`http://127.0.0.1:8000/v1`でリッスンします。

## 2. ChatMockを使用するようにTomoriBotを構成する

DiscordでTomoriBotの`custom`プロバイダーを構成し、以下を使用します。

- **Endpoint URL**: `http://127.0.0.1:8000/v1`
- **Model Name**: `gpt-5.4`や`gpt-5.3-codex`など、ChatMockが受信すべき正確なモデル文字列。

末尾のパスがない`http://127.0.0.1:8000`も使用できます。TomoriBotは`/chat/completions`を追加する前に`/v1`へ正規化します。

ChatMockの以下の機能フラグを有効にします。
- **Function Calling / Tools**: Yes
- **Image Understanding**: Yes
- **Video Understanding**: No
- **Structured Output**: Yes

**注意**: Codex CLIでは`system`プロンプトを変更できないため、回避策としてTomoriBotの`system`プロンプトはコンテキスト内の`user`のターンに変換されます。この回避策が適切に機能するように、`.env`変数の`CHATMOCK_PORT`を実際のChatMockのポート（デフォルトは8000）と一致するように構成してください。
