---
title: "Chatterbox TTS"
---

高速で多言語対応のTTSボイスクローニングエンドポイントには、`servers/tts/chatterbox/server.py`を使用します。デフォルトではChatterbox-Turboとなっており、ブラケット配信タグを保持し、高速な推論を行います。

## セットアップ

TomoriBotのリポジトリのルート（TomoriBotをクローンしたフォルダー）から以下のコマンドを実行します。

### Windows PowerShell

```powershell
python -m venv servers\tts\chatterbox\.venv
servers\tts\chatterbox\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install numpy
pip install -r servers\tts\chatterbox\requirements.txt
python servers\tts\chatterbox\server.py
```

### Linux/macOS Bash

```bash
python3 -m venv servers/tts/chatterbox/.venv
source servers/tts/chatterbox/.venv/bin/activate
python -m pip install --upgrade pip
python -m pip install numpy
python -m pip install -r servers/tts/chatterbox/requirements.txt
python servers/tts/chatterbox/server.py
```

TomoriBotがChatterboxを使用している間は、そのターミナルを開いたままにしてください。デフォルトのエンドポイントURLは`http://127.0.0.1:8011`です。

## TomoriBotへの登録

`/providers`で **Add New Custom Endpoint** を選びます。

- API Compatibility: `tts-clone`
- `endpoint_url`: `http://127.0.0.1:8011`

保存したエンドポイントを選択し、**Add or Edit a Model** で新しい音声モデルに以下を設定します。

- `Voice Source Mode`: `Clone`
- `Script Markup Style`: `Bracket Tags`

登録すると、エンドポイントはすぐに有効になります。今後、speechエンドポイントを切り替える場合にのみ`/providers`を使用します。

## ペルソナ音声のセットアップ

1. 背景音楽のない、1人の話者による10〜20秒のクリアな音声クリップを準備します。
2. `/config`を実行してクリップをアップロードします。
3. `/speech voice-assign`を実行し、ペルソナと音声サンプルを選択します。

Chatterboxは、Turboモードが有効な場合、`[laugh]`や`[sigh]`などのブラケット配信タグを使用できます。

## オプションのチューニング

Chatterboxのリクエストペイロードを調整するには、`/config`を使用します。

- `turbo`のデフォルトは`true`です。有効な場合、TomoriBotはサポートされているChatterbox-Turboのイベントタグを保持し、ラッパーが`ChatterboxTurboTTS.model.generate(...)`を使用する前に、サポートされていないブラケット記述子を削除します。
- `cfg_weight`のデフォルトは`0.5`です。最小値は`0`で、TomoriBotはハード的な最大値を設定していません。これは`turbo`が`false`の場合にのみ適用され、値を低くすると速い参照音声を遅くするのに役立ち、値を高くすると参照音声に強く従うようになります。
- `exaggeration`のデフォルトは`0.5`です。最小値は`0`で、TomoriBotはハード的な最大値を設定していません。これは`turbo`が`false`の場合にのみ適用され、値を高くすると配信がより表現豊かまたはドラマチックになり、話すスピードが速くなる場合があります。

サポートされているTurboイベントタグは、`[clear throat]`、`[sigh]`、`[shush]`、`[cough]`、`[groan]`、`[sniff]`、`[gasp]`、`[chuckle]`、および`[laugh]`です。`[stammers]`、`[blushes]`、または`[smiles]`などのサポートされていない記述子は、TTSに送信される前に削除されます。

`turbo`が無効な場合、TomoriBotはテキストをTTSに送信する前にすべてのブラケット記述子を削除し、ラッパーが標準の`ChatterboxTTS`モデルを遅延読み込みして、`model.generate(..., cfg_weight, exaggeration)`を呼び出します。
