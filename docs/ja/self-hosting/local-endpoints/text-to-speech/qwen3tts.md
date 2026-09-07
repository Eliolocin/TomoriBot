---
title: "Qwen3-TTS"
---

現在のTomoriBotのオプションの中で最大かつ最も正確なTTSである、両方のQwen3-TTS 12Hz 1.7Bモードには、`servers/tts/qwen3tts/server.py`を使用します。デフォルトではオートモードで起動し、各リクエストの形状からBaseのボイスクローンモデルまたはVoiceDesignモデルを選択します。

## セットアップ

TomoriBotのリポジトリのルート（TomoriBotをクローンしたフォルダー）から以下のコマンドを実行します。

### Windows PowerShellを使用する場合

```powershell
python -m venv servers\tts\qwen3tts\.venv
servers\tts\qwen3tts\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r servers\tts\qwen3tts\requirements.txt
python servers\tts\qwen3tts\server.py
```

### Linux/macOS Bashを使用する場合

```bash
python3 -m venv servers/tts/qwen3tts/.venv
source servers/tts/qwen3tts/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r servers/tts/qwen3tts/requirements.txt
python servers/tts/qwen3tts/server.py
```

オートモードのデフォルトのエンドポイントURLは`http://127.0.0.1:8012`です。オートモードを明示的に指定することもできます。

```powershell
python servers\tts\qwen3tts\server.py --mode auto
```

オートモードは、各`/synthesize`リクエストを検査します。`ref_audio`を含むリクエストはクローンモデルを使用し、`instruct`を含むリクエストはVoiceDesignモデルを使用します。一度に1つのモデルのみを読み込み、リクエストタイプが変更されるとモデルを入れ替えるため、入れ替え後の最初のリクエストは遅くなる場合があります。

## TomoriBotへの登録

ほとんどのユーザーは、1つのエンドポイントでボイスクローンとVoiceDesignの両方のペルソナをサポートできるように、オートモードサーバーを登録します。

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8012`

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい音声モデルに以下を設定します。

- `Voice Source Mode`: `Auto`
- `Script Markup Style`: `Plain`

登録すると、エンドポイントはすぐに有効になります。今後、speechエンドポイントを切り替える場合にのみ`/providers`を使用します。

## ペルソナ音声のセットアップ

### ボイスクローニング

参照クリップを模倣する必要があるペルソナには、これを使用します。

1. 背景音楽のない、1人の話者による10〜20秒のクリアな音声クリップを準備します。
2. `/config`を実行してクリップをアップロードします。
3. `/config`を実行し、ペルソナと音声サンプルを選択します。

### VoiceDesign

サンプルの代わりに書かれた音声の説明を使用する必要があるペルソナには、これを使用します。

1. `/config`を実行します。
2. ペルソナを選択します。
3. 話者の年齢、トーン、アクセント、話し方など、自然言語の音声プロンプトを入力します。

ペルソナのVoiceDesignプロンプトを削除するには、`/config`を使用します。生成中、TomoriBotは保存されたプロンプトを`/synthesize`のJSON本文に`instruct`として送信します。ツールからの1回限りの`voice_instructions`は末尾に追加されます。

オートモードは両方のセットアップを保持します。`/config`で設定されたペルソナは選択に応じてクローン合成またはVoiceDesign合成を使用します。

## (オプション) VoiceDesign専用サーバー

`Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign`を提供する場合、VoiceDesignモードで同じサーバーを起動します。

Windows PowerShell:

```powershell
servers\tts\qwen3tts\.venv\Scripts\Activate.ps1
$env:TOMORI_TTS_MODE = "voice-design"
python servers\tts\qwen3tts\server.py
```

Bash:

```bash
source servers/tts/qwen3tts/.venv/bin/activate
TOMORI_TTS_MODE=voice-design python servers/tts/qwen3tts/server.py
```

`TOMORI_TTS_MODE`を設定する代わりに、`--mode voice-design`を渡すこともできます。デフォルトのVoiceDesign専用エンドポイントURLは`http://127.0.0.1:8014`です。

オートモードと同じ方法で登録しますが、エンドポイントURLに`http://127.0.0.1:8014`を使用し、音声ソースモード（voice source mode）として`VoiceDesign`を選択します。
