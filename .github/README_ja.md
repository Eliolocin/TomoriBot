## [English](../README.md) | 日本語

> [!NOTE]
> このREADMEは簡単な概要です。完全で最新のドキュメント（セットアップガイド、機能の解説、プロバイダー情報など）については **[docs.tomoribot.app](https://docs.tomoribot.app/ja/)** をご覧ください。

<br />
<div align="center">

  <a href="https://github.com/Bredrumb/TomoriBot">
    <img src="assets/img/icons/tomoricon.svg" alt="Logo" width="80" height="80">
  </a>

<h3 align="center">TomoriBot</h3>

Discord向けの自ホスト可能でカスタマイズ自在な個人AIアシスタント/ロールプレイシステム。メモリー、複数ペルソナ、ツール呼び出し、マルチモーダル、API/ローカルモデルサポートを備えています。

<p align="center">
  <strong><a href="https://docs.tomoribot.app/ja/">公式ウェブサイト</a></strong>
  &middot;
  <strong><a href="https://discord.com/oauth2/authorize?client_id=841644102059556915">TomoriBotを招待</a></strong>
  &middot;
  <strong><a href="https://discord.gg/bjCfHm9QsB">Discordサーバー</a></strong>
  <br />
  <a href="https://github.com/Bredrumb/TomoriBot/releases">最新リリース</a>
  &middot;
  <a href="https://github.com/Bredrumb/TomoriBot/issues/new?template=bug-report.md">バグ報告</a>
  &middot;
  <a href="https://github.com/Bredrumb/TomoriBot/issues/new?template=feature-request.md">機能リクエスト</a>
  <br />
  <br />

[![GitHub Stars](https://img.shields.io/github/stars/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/forks)
[![GitHub Issues](https://img.shields.io/github/issues/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/issues)
[![GitHub Pull Requests](https://img.shields.io/github/issues-pr/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/pulls)
[![License](https://img.shields.io/github/license/Bredrumb/TomoriBot.svg)](https://github.com/Bredrumb/TomoriBot/blob/main/LICENSE)


  </p>

  




<!-- PROJECT LOGO -->
![TomoriBot Banner](assets/img/tomobanner.png)
[![Bun][Bun.sh]][Bun-url][![Discord.js][Discord.js]][Discord-url][![TypeScript][TypeScript.js]][TypeScript-url][![PostgreSQL][PostgreSQL.org]][PostgreSQL-url]

  
</div>

<!-- ABOUT THE PROJECT -->
## プロジェクトについて

TomoriBotは、SillyTavernとDiscordの廃止されたClydeにインスパイアされた、無料でオープンソースの自ホスト型個人AIアシスタント兼ロールプレイシステムです。DMでは自分専用の、Discordサーバーでは全員のための、実用的なアシスタント、カスタマイズ可能なコンパニオン、ロールプレイの相手として使えます。

TomoriBotは長期メモリー、マルチペルソナ動作、WebおよびMCPツール、チャット内でのメディア生成、200以上のDiscordスラッシュコマンド、そしてカスタムプロキシや自前モデルの自ホストを含む複数のプロバイダーをサポートし、テキスト生成から動画生成まで幅広く対応します。

### はじめに

[公開版TomoriBotを招待](https://discord.com/oauth2/authorize?client_id=841644102059556915)してDiscordサーバーに追加するか、プライバシーとAPIキーを完全にコントロールしたい場合は[自分でホスト](#セルフホスティング)することもできます。TomoriBotはデータを安全に保つためにセキュリティのベストプラクティスと暗号化を用いていますが、セルフホスティングならすべてのデータが完全にあなたのデバイス上にとどまります。

上記いずれかの方法でサーバーに追加した後、`/setup`コマンドを実行して手順を確認してください。その後は、彼女の名前を呼ぶ（または@メンションする）だけで応答が得られます。

## 機能紹介


![Screenshots 1](assets/img/scs/1.png)
<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/capabilities/tools-and-extensions/">エージェント型AI駆動の会話</a></h3>
<p align="center">TomoriBotはチャットするだけにとどまらない多彩なツールを備えています。Web検索、繰り返しタスク/リマインダーの設定、サーバーの絵文字/スタンプの活用、そしてチャンネルやサーバーをまたいでコンテキストを記憶できるRAGやSTMなどのメモリー機能が使えます。</p>

<br />


![Screenshots 2](assets/img/scs/2.png)
<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/capabilities/media-generation/">完全なマルチモーダル入出力</a></h3>
<p align="center">TomoriBotはDiscordで直接送信された画像・音声・動画を処理し、あなた自身のローカルモデルエンドポイントやAPIキーを使ってそれらを生成して返せます。これらはすべて暗号化され、永続的なデータベースに安全に保存されます。すぐに使えるComfyUIワークフローは<code>assets/comfyui-workflows/</code>に、ローカル音声推論サーバーは<code>servers/</code>にあります！</p>

<br />

![Screenshots 3](assets/img/scs/3.png)
<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/chatting-personality/multiple-personas/">マルチペルソナサポート</a></h3>
<p align="center">TomoriBotのサーバー内でのパーソナリティ、行動、アバターは簡単に変更・作成でき、ペルソナとして他のユーザーへエクスポートすることもできます（共有可能なAIキャラクターカードのようなもの）。<code>/persona generate</code>でお気に入りのSillyTavernカードをインポート・変換することも可能です。1つのサーバーに無制限のペルソナを持たせることができ、それぞれが独自のメモリーとアジェンダを持ちます。さらに、複数のペルソナを連携させてサーバー内で協働させる（あるいはただじゃれ合わせる）こともできます。</p>

<br />


![Screenshots 4](assets/img/scs/4.png)
<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/command-reference/">200以上のネイティブ設定コマンド</a></h3>
<p align="center">すべてDiscordのネイティブなスラッシュコマンドとインタラクティブUIで管理できます。ペルソナやプロンプトの完全な管理、モデルパラメータの調整、MCPツールサーバーの設定、権限の調整、メモリーの設定、サーバーメンバーのレート制限など、さらに多くのことが可能です。TomoriBotに、彼女ができることやスラッシュコマンドを直接尋ねることもできます。現在、さらに簡単な管理のためにWebダッシュボードを開発中です。</p>

<br />


![Screenshots 6](assets/img/scs/6.png)

<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/integrations/sillytavern-support/">SillyTavern統合（ベータ）</a></h3>
<p align="center">お気に入りのSillyTavernプリセットをTomoriBotを通じてDiscordで直接使用でき、彼女のプロンプトを丸ごと調整します。<code>st-preset</code>で.jsonをそのまま入れるだけです。Discordの新しいモーダル用ネイティブチェックボックスグループにより、SillyTavernのようにノードのオン/オフを簡単に切り替えられます。<code>/persona import</code>でSillyTavernキャラクターカードを直接インポートするか、<code>/persona generate</code>で先に手を加えることもできます。</p>

![Screenshots 5](assets/img/scs/5.png)
<h3 align="center"><a href="https://docs.tomoribot.app/ja/features/">さらに多くの機能が続々追加中！</a></h3>
<p align="center">新しいサーバーメンバーへの自動挨拶やチャンネル間の移動など実用的なものから、ユーザーのなりきりでちょっとしたおふざけをするものまで、簡単に設定できる楽しい機能が揃っています。新機能は常に開発中ですので、バグ（や楽しい提案）はGitHub Issuesまたは公式Discordで報告してください。</p>

## 役立つリソース

### [対応プロバイダーの完全なリスト](https://docs.tomoribot.app/ja/features/setup-administration/providers-and-models/#サポートされているプロバイダー)
TomoriBotは、幅広いLLMプロバイダー、画像生成API、音声サービス、検索ツールを標準でサポートしています。

### [ローカルモデルの実行方法](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/)

TomoriBotはローカルLLM（KoboldCPP、LM Studio、vLLM経由など）、ComfyUIによるローカル画像/動画生成、ローカルTTS・STTエンドポイント、さらにローカルのSearXNGやブラウザWeb取得用のDockerサイドカーに対応しています。

### [セキュリティと脅威モデル](https://docs.tomoribot.app/ja/wiki/threat-models/)

TomoriBotは暗号化とセキュリティのベストプラクティスを採用し、ローカル環境でもパブリックデプロイでも、データとAPIキーを完全に安全に保ちます。

### [プロンプトカスタマイズ用ツールマクロ](https://docs.tomoribot.app/ja/features/capabilities/tools-and-extensions/)

TomoriBotには多彩なビルトインツール（Web検索、メモリー管理、画像生成、クロスチャンネルメッセージングなど）が備わっており、プロンプト内でマクロとして直接参照できます。以下はいくつかのおふざけな例です：

#### 1. ウェルネスチェッカー
```text
数時間おきに、@Bredrumbの様子を必ず確認する。
今の気分はどうか、最近コーディングの休憩を取れているかを尋ねる。
{memory_tool}や{memory_update_tool}で彼の感情の状態を時系列で記録し、後で本人に報告する。
```
#### 2. 週刊 ~~時事~~ 百合ニュース
```text
毎週金曜日、{web_search_tool}を使ってその週の注目の百合漫画の章、アニメエピソード、コミュニティのファンアートをまとめる。
まとめた内容を{voice_message_tool}で艶っぽいASMRボイスで発表する。
```
#### 3. 睡眠ポリス
```text
{message_metadata_tool}で誰かが午前2時を過ぎてもチャットしていることに気づいたら、{voice_message_tool}で不気味なほど穏やかなASMRの子守唄を送り、寝るように伝える。
10分後もまだ話し続けていたら、{manage_message_tool}でその人のためを思ってメッセージを削除し、睡眠不足が彼らの問題の主な原因であることを念押しする。
```
### [公式TomoriBotロードマップ](https://github.com/users/Bredrumb/projects/1/views/1)

TomoriBotの予定されている機能や既知の問題の最新情報を確認できます。


<!-- GETTING STARTED -->
## セルフホスティング

インストール方法を1つ選んでください：

- **A. ローカルBunセットアップ（推奨）:** Bun、MCPツール用のNode.js v20+、およびデータベース用にPostgreSQLまたはDockerのいずれかが必要です。
- **B. Docker Composeセットアップ:** ボット/データベースの実行にはDockerのみが必要ですが、ホスト側のメンテナンススクリプトには依然としてホストのツールが必要です。

ほとんどのセルフホスターにおすすめなのは、ローカルBunのセットアップウィザードです。デフォルトの**フルインストール**では、`.env`の作成、安全な`CRYPTO_SECRET`の生成、Discordボットトークンの入力、PostgreSQLの設定、`bun install --frozen-lockfile`の実行を行い、続いて軽量なデータベースおよびAIヘルパーの追加機能のインストールを試みます。

### A. ローカルBunセットアップ

1. **リポジトリをクローン**
   ```sh
   git clone https://github.com/Bredrumb/TomoriBot.git
   cd TomoriBot
   ```

2. **セットアップウィザードを実行**（詳細は**[セットアップウィザードガイド](https://docs.tomoribot.app/ja/self-hosting/setup-wizard/)**を参照）
   ```sh
   bun run setup
   ```

3. **TomoriBotを起動**
    ```sh
    bun run dev
    ```

`TomoriBot up and running!`と表示されたら、Discordで`/setup`を実行してください。

### B. Docker Composeセットアップ

Docker ComposeはTomoriBotとPostgreSQLをビルドして実行します。セットアップウィザードは使用しません。

**Docker Composeに必要な`.env`変数：**
- `DISCORD_TOKEN` - Discordボットトークン
- `CRYPTO_SECRET` - 32文字の暗号化キー
- `POSTGRES_PASSWORD` - データベースパスワード（他のDB設定は自動設定されます）

Docker Composeの場合は、`.env.example`をベースにして、まだ設定していなければ`POSTGRES_PASSWORD`を追加してください。任意のDockerやランタイム調整用の値は`.env.optional.example`からコピーできます。

```sh
# TomoriBotとそのデータベースをビルドして起動
docker compose up --build
```

以降の起動では、コードや依存関係を変更していない限り`docker compose up`だけで十分です。

### C. オプションのサイドカー・サーバー

TomoriBotは、どちらのセットアップ方法でも併用できるオプトイン方式のサイドカー/サーバーサービスをサポートしており、ツールの強化やローカルモニタリングに利用できます：Web検索用のSearXNG、ブラウザレンダリングによるページ取得用のCrawl4AI、ローカルTTS/STT音声サーバーが含まれます。

**ローカルBunセットアップ（A）の場合**は、`bun run dev`の代わりに`bun run launch`を使用します。実行例：

```sh
# SearXNGとCrawl4AIのDockerサイドカーを併用
bun run launch --searxng --crawl4ai

# 音声セットアップ手順に従った後、ローカルTTSサーバーを併用
bun run launch --qwen3tts

# 利用可能なフラグをすべて表示
bun run launch --help
```

利用可能なフラグ： `--searxng`、`--crawl4ai`、`--qwen3tts`、`--chatterbox`、`--irodoritts`、`--whisperx`、`--help`

**Ctrl+C**でボットとPython製サイドカープロセスが停止します。Dockerコンテナ（`--searxng``--crawl4ai`）は意図的に起動したまま残されます。終了時は`docker stop searxng` / `docker stop crawl4ai`で手動停止してください。

**Docker Composeセットアップ（B）の場合**は、代わりにComposeプロファイルでサイドカーをオプトインします：

```sh
# + SearXNG Web検索（自ホスト型メタ検索）
docker compose --profile searxng up

# + Crawl4AI ブラウザレンダリングによるページ取得
docker compose --profile fetch-crawl4ai up

# + 両方同時に
docker compose --profile searxng --profile fetch-crawl4ai up
```

詳細なセットアップ手順については、以下のガイドを参照してください：

- **[SearXNG Web検索サイドカー](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/setup-searxng/)** - `web_search`ツールで単一エンジンのAPI制限を回避するための自ホスト型メタ検索インスタンス。
- **[Crawl4AIサイドカー](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/setup-crawl4ai/)** - `fetch_url`ツールでJavaScriptの多いWebページを取得・処理するためのブラウザレンダリングサイドカー。
- **[テキスト読み上げ（TTS）](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/text-to-speech/)** / **[音声認識（STT）](https://docs.tomoribot.app/ja/self-hosting/local-endpoints/speech-to-text/)** - TomoriBotのボイスメッセージ用のPython製音声サーバー。事前に一度venvのセットアップが必要です。

### TomoriBotの更新

セルフホストしているインスタンスを最新バージョンに更新するには、まずボットを停止し（バックアップとマイグレーションが静かなデータベースに対して実行されるように）、バックアップ優先の更新コマンドを実行します：

```sh
bun run update
```

このコマンドは以下の手順を順番に実行し、いずれかの手順が失敗した場合は即座に停止します：

1. **`bun run backup`** - コードに触れる*前に*データベースの完全バックアップを`/backups/`へ取得します。バックアップに失敗した場合、デプロイに一切変更を加えずに更新を中断します。
2. **`git pull --rebase --autostash`**
3. **`bun install --frozen-lockfile`**

その後、`bun run dev`または`bun run launch`でTomoriBotを再起動してください。

便利なフラグ：

| フラグ | 効果 |
|---|---|
| `--build` | 依存関係のインストール後に`bun run build`も実行します |
| `--docker` | Docker Compose用：手順3を`docker compose build` + `docker compose up -d`に置き換えます |
| `--skip-backup` | 更新前のバックアップをスキップします（非推奨） |
| `--yes` | 開始前の確認プロンプトをスキップします |

すべてのホスト側スクリプトの詳細については、**[メンテナンスドキュメント](https://docs.tomoribot.app/ja/features/command-reference/)**の全文を参照してください。

<!-- AFTER SETUP -->
### 招待・セットアップ後

#### 基本コマンド

- `/setup` - サーバーの初期ボットセットアップ
- `/config` - TomoriBotを調整するための複数の方法
- `/personal memories` - 個人メモリーの追加/削除
- `/memories` / `/memories` - サーバー全体のメモリーの追加/削除
- `/moderation` - TomoriBotの権限の追加/削除

すべてのスラッシュコマンドについては、**[コマンドリファレンス](https://docs.tomoribot.app/ja/features/command-reference/)**の全文を参照してください。

#### チャットでのやり取り

サーバーでボットをメンションするか、設定されたトリガーワードを使用して会話を開始します：
```
@TomoriBot yo wassup
```

または、TomoriBotのDMに入って挨拶してください！

<!-- CONTRIBUTING -->
## コントリビュート

TomoriBotへのコントリビュートは大歓迎です！プルリクエストを作成する前に、以下のリソースをご確認ください：

- **[コントリビュートドキュメント](https://docs.tomoribot.app/ja/contributing/)**: スラッシュコマンド、ツール、イベントハンドラ、新しいAIプロバイダー、およびロケールの追加に関する包括的なステップバイステップガイド。
- **[コントリビュートガイドライン](.github/CONTRIBUTING.md)**: ブランチ運用、品質ゲートのチェック、そして事前相談なしで歓迎されるコントリビュートの範囲がまとめられたリポジトリルール。

<!-- LEGAL -->
## 法的事項とライセンス

### 公式ホスティング版TomoriBotインスタンスのユーザー向け
- **[利用規約](https://docs.tomoribot.app/ja/legal/terms-of-service/)** - ボット使用のルールとガイドライン
- **[プライバシーポリシー](https://docs.tomoribot.app/ja/legal/privacy-policy/)** - データの取り扱いについて

これらのドキュメントは、Discord内で`/legal terms`および`/legal privacy`コマンドを使用してもアクセスできます。

### セルフホスティングまたはフォークを使用するユーザー向け
あなたは自分自身のデータを管理し、[**GNU Affero General Public License v3.0**](https://github.com/Bredrumb/TomoriBot/blob/main/LICENSE)の下でのデプロイのコンプライアンスに責任を負います。

<!-- CONTACT -->
## 連絡先とリンク

**公式ウェブサイト**: [https://docs.tomoribot.app](https://docs.tomoribot.app/ja/)

**プロジェクトリンク**: [https://github.com/Bredrumb/TomoriBot](https://github.com/Bredrumb/TomoriBot)

**Email**: bredrumb@gmail.com

**Discord**: [公式サポートサーバー](https://discord.gg/bjCfHm9QsB)

<!-- SUPPORT -->
## プロジェクトのサポート

TomoriBotが役立ったと感じ、今後の開発を支援したい場合は、GitHubで⭐を付けるか、Ko-fiを通じてサポートをご検討ください！

<p align="left">

  &nbsp;
  <a href="https://ko-fi.com/bredrumb">
    <img src="https://img.shields.io/badge/Support_on_Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support on Ko-fi">
  </a>
</p>

<!-- MARKDOWN LINKS & IMAGES -->
[TypeScript.js]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Bun.sh]: https://img.shields.io/badge/Bun-f472b6?style=for-the-badge&logo=bun&logoColor=white
[Bun-url]: https://bun.sh/
[Discord.js]: https://img.shields.io/badge/Discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white
[Discord-url]: https://discord.js.org/
[PostgreSQL.org]: https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white
[PostgreSQL-url]: https://www.postgresql.org/
[Google.ai]: https://img.shields.io/badge/Google%20AI-4285F4?style=for-the-badge&logo=google&logoColor=white
[Google-url]: https://ai.google.dev/
