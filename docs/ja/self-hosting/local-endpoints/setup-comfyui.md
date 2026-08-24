---
title: "セットアップ: ComfyUI"
sidebar:
  order: 2
---

TomoriBotは、自身の[ComfyUI](https://github.com/comfyanonymous/ComfyUI)インスタンスを通じて画像や動画を生成できます。プロンプトやサイズを置換した**APIフォーマットのワークフロー**を送信することでComfyUIを操作し、出力の準備ができるまでComfyUIの`/history`エンドポイントをポーリングします。

このガイドでは、ComfyUIのインストール、実行、および登録について説明します。TomoriBot互換のワークフロー（`{TOMORI_*}`プレースホルダー）の**作成または編集**については、`/help`の **機能** から **カスタムエンドポイント** を開き、GitHubの[ワークフローのREADME](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows)も使用してください。

:::note[環境変数は不要です]
ComfyUIはDiscordのスラッシュコマンドを通じて登録され、データベースに暗号化されて保存されます。
[ローカルエンドポイントハブ](/ja/self-hosting/local-endpoints/)を参照してください。
:::

## ハードウェア要件

画像と動画の生成は**GPUに依存**します。最大のコストは**VRAM**（システムRAMとは別の、グラフィックカードのメモリ）であり、これはComfyUI自体ではなく、ワークフローが読み込むモデルチェックポイントによって決まります。NVIDIAのGPUを強く推奨します。TomoriBotに同梱されている2つのワークフローは、どちらもモダンでSDXLよりも重いモデルです。

| 同梱ワークフロー | ベースモデル | 実用的なVRAM | 備考 |
|---|---|---|---|
| **Anima v1** (画像) | Qwen-Image (~20B)、fp8 | 下限約16 GB · 快適24 GB | テキストエンコーダーとVAEで約8〜10 GBのオーバーヘッドが追加されます。16 GB未満の場合は、GGUFビルドと`--lowvram`を使用してください。 |
| **WAN i2v loop** (動画) | Wan 2.2 14B、fp8 + 4ステップLightX2V LoRA | 動作可能約16 GB · 快適24 GB以上 | 最も重いオプションであり、**1クリップあたり数分**かかることを想定してください。小規模なカードでは、UMT5テキストエンコーダーをRAMにオフロード（`t5_cpu`、24 GB以上のシステムRAMが必要）してください。 |

同梱されているチェックポイントはどちらも、コンシューマー向けカードに収まるようにすでに**fp8量子化**されています。VRAMが少ない場合は、UNETをより小さな量子化モデルに交換し、ComfyUIの`--lowvram` / CPUオフロードを有効にしてください。CPUのみでのディフュージョンは非現実的であり（画像1枚に数分かかり、動画ではさらに悪化します）、TomoriBotのポーリングウィンドウを超える可能性があるため、通常の使用には実質的にGPUが必要です。

:::tip[さらに軽くする: GGUF量子化を選択する]
**量子化**は、各モデルの重みをより少ないビット数で保存することで、VRAMとディスクの使用量を削減しますが、わずかな精度の低下を伴います。同梱のfp8ファイルはそのマイルドな形式であり、さらに縮小するには、Hugging Faceからモデルの**GGUF**ビルドをダウンロードします。`Q4_K_M`や`Q5_K_M`のような名前のコードは重みあたりのビット数であり、**4ビット（Q4）または5ビット（Q5）が通常のスイートスポット**で、fp8/fp16の何分の一かのフットプリントでほとんどの品質を維持します。4ビット未満にするとさらに縮小しますが、急速に劣化します。ComfyUIでGGUF UNETを読み込むには、[ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF)カスタムノードが必要です。
:::


## 1. APIを有効にしてComfyUIを実行する

[README](https://github.com/comfyanonymous/ComfyUI)に従ってComfyUIをインストールし、ネットワークでリッスンするように起動します。

```sh
python main.py --listen 0.0.0.0 --port 8188
```

TomoriBotがDockerまたは別のマシンで実行されている場合、`--listen 0.0.0.0`が重要になります。デフォルトではループバックのみにバインドされるためです。**ボットが実行されているマシンから**到達可能であることを確認してください。

```sh
curl http://127.0.0.1:8188/system_stats
```

テストする場合は、選択したワークフローが想定するモデルチェックポイントをロードし、ComfyUIのWeb UIで手動生成を1回実行して、TomoriBotに接続する前にエンドツーエンドで機能することを確認してください。

## 2. TomoriBotのワークフローを取得する

すぐに使用できる**APIフォーマット**のワークフローをダウンロードします。例はリポジトリの[`assets/comfyui-workflows/`](https://github.com/Bredrumb/TomoriBot/tree/main/assets/comfyui-workflows)の下にあります。

| ワークフロー | モード |
|----------|-------|
| Anima v1 (画像) : `tomoribot-anima-v1-comfyui.json` | `txt2img`, `img2img`, `inpaint` |
| WAN i2v loop (動画) : `tomoribot-wan-i2v-loop-video.json` | image-to-video |

これらは**APIフォーマット**（ComfyUIが*Save (API Format)*でエクスポートするJSON）であり、通常のUI保存フォーマットではありません。独自に作成する場合は、TomoriBotが置換する`{TOMORI_*}`プレースホルダー（プロンプト、幅/高さ、シード、参照画像など）を含める必要があります。ワークフローのREADMEと、`/help`の **機能** にある **カスタムエンドポイント** を参照してください。

## 3. Discordに登録する

**`/providers`**（または`/personal providers`）で **Add New Custom Endpoint** を選び、以下を入力します。

| フィールド | ComfyUI用の値 |
|-------|-------------------|
| `endpoint_label` | 選択した名前（例: `home-comfy`） |
| API Compatibility | `ComfyUI` |
| `endpoint_url` | `http://127.0.0.1:8188`（ルート、`/v1`は**なし**） |
| `auth_token` | *(ComfyUIが認証の背後にない限り空白のままにします)* |

保存したエンドポイントを選択し、**Add or Edit a Model** で画像または動画モデルを追加します。ステップ2でダウンロードした**ワークフローの`.json`をアップロード**し、使用方法と一致するサポートモード（画像の場合は`txt2img` / `img2img` / `inpaint`）を選択します。モデルの機能はワークフローと一致している必要があります（画像ワークフロー → `image`、動画ワークフロー → `video`）。

これを登録すると、自動的にアクティブな`image`/`video`モデルになります。チャットでトモリに直接尋ねて生成をトリガーします。何らかの理由でアクティブにならない場合は、`/model image`（または`/model video`）を実行し、登録したComfyUIエンドポイントを選択します。

## トラブルシューティング

- **追加時に到達不能になる:** ボットがDocker内、または別のホストにある間に、ComfyUIがループバックにバインドされました。`--listen 0.0.0.0`で起動し、`http://host.docker.internal:8188`またはLAN IPを使用してください。
- **生成が完了しない:** TomoriBotは、出力が表示されるまで`/history`をポーリングします。コールドスタートやCPU上の大規模モデルは、ポーリングウィンドウを超える可能性があります。
- **プロンプト/サイズが無視される、または出力サイズが間違っている:** ワークフローに必須の`{TOMORI_*}`プレースホルダーが欠落しているか、APIフォーマットではなくUIフォーマットのエクスポートをアップロードしました。
- **機能が間違っている:** `video`で登録された`image`ワークフロー（またはその逆）は実行されません。一致する機能で再追加してください。
