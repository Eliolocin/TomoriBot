---
title: "手動セットアップ"
sidebar:
  order: 2
---

:::note
Docker Composeを使用したいユーザーはこのウィザードをスキップし、コンテナ化されたインストールパスについては[Docker Compose](/ja/self-hosting/docker-compose/)を参照してください。
:::

これは、ガイド付きウィザードを使用したくない技術的なユーザー向けの手動インストール手順です。手厚いガイドラインが必要な場合は、代わりに[セットアップウィザード](/ja/self-hosting/setup-wizard/)を使用してください。ウィザードが `.env` を作成し、安全な `CRYPTO_SECRET` を生成し、PostgreSQLを設定し、インストールを実行してくれます。

## 前提条件

- [Bun](https://bun.sh/)
- Node.js v20以上（MCPツールに使用）
- ネイティブにインストールされたPostgreSQL、またはDockerコンテナで実行されているPostgreSQL（ステップ2を参照）

PostgreSQLスキーマ、`pgcrypto`、シード、および移行は、ボットの起動時に自動的に初期化されます。

## 1. インストール

```sh
git clone https://github.com/Bredrumb/TomoriBot.git
cd TomoriBot
bun install --frozen-lockfile
```

## 2. 設定

サンプルから環境ファイルを作成し、必要な値を入力します。

```sh
cp .env.example .env
```

必須項目：

- `DISCORD_TOKEN`：Discordボットのトークン（`GuildMembers`、`MessageContent`、および `GuildPresences` の特権インテントを有効にしてください）。
- `CRYPTO_SECRET`：32文字の暗号化キー（保存されたAPIキーを暗号化するために使用されます）。
- PostgreSQL接続：`POSTGRES_HOST`、`POSTGRES_PORT`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`。

:::note[ネイティブのPostgreSQLがない場合]
コンテナでデータベースのみを実行し、`POSTGRES_*` の値をそこに向けて設定します。

```sh
docker run -d --name tomori-db \
  -e POSTGRES_USER=tomori -e POSTGRES_PASSWORD=yourpassword -e POSTGRES_DB=tomori \
  -p 5432:5432 pgvector/pgvector:pg16
```

その後、`POSTGRES_HOST=localhost`、`POSTGRES_PORT=5432`、および上記のユーザー/パスワード/DBを設定します。`pgvector/pgvector` イメージにはRAG拡張機能がプレインストールされています。ドキュメント/RAGメモリーが不要な場合は、`postgres:16` に変更してください。これはデータベースのみをDockerで実行するものであり、ボット自体は引き続きホストのBunで実行されます。ボットとデータベースを完全にコンテナ化したい場合は、代わりに[Docker Compose](/ja/self-hosting/docker-compose/)を使用してください。
:::

オプションの調整値は `.env.optional.example` にあります。カスタマイズしたい値（制限、タイムアウト、機能トグル、サイドカーURLなど）をコピーしてください。

## 3. 実行

```sh
bun run dev
```

`TomoriBot up and running!` と表示されたら、Discordに移動してサーバーで `/setup` を実行し、AIプロバイダーのキーを追加してボットを初期化します。Discord側の操作については[クイックスタート](/ja/introduction/quickstart/)を参照してください。

オプションのサイドカー（SearXNG、Crawl4AI、ローカルTTS/STT）をボットと一緒に起動したい場合は、`bun run dev` の代わりに `bun run launch` を使用します。

```sh
bun run launch --searxng --crawl4ai
bun run launch --help        # すべてのフラグを表示
```

## オプションの追加機能（手動での「フルインストール」）

[セットアップウィザード](/ja/self-hosting/setup-wizard/)の**フルインストール**パスでは、基本インストールの上に4つの軽量な追加機能がレイヤー化されます。ボットの実行に必須のものはありませんが、それぞれが特定の機能をアンロックします。手動でインストールする場合は、必要なものを追加してください。

### `pgvector` : ドキュメント/RAGメモリー

RAG（ドキュメントのアップロードとチャンネル間のリコール）は、エンベディングを `vector` カラムに保存するため、[pgvector](https://github.com/pgvector/pgvector)拡張機能が必要です。お使いのPostgreSQLのメジャーバージョンに合わせてインストールします。

```sh
# Debian/Ubuntu（例: PostgreSQL 16の場合）
sudo apt-get install -y postgresql-16-pgvector
```

次に、データベースで一度だけ有効にします。`.env` の `POSTGRES_*` の値を使って `psql` で接続します（`POSTGRES_PASSWORD` の入力を求められます）。

```sh
# ネイティブ / ホストのpsql（POSTGRES_USER と POSTGRES_DB はご自身の値に置き換えてください）:
psql -h localhost -p 5432 -U tomori -d tomodb

# または、データベースをステップ2のDockerコンテナで実行している場合:
docker exec -it tomori-db psql -U tomori -d tomori
```

接続したら、次を実行します。

```sql
CREATE EXTENSION vector;
```

:::note[Windows]
ネイティブのWindows版PostgreSQL向けにビルド済みのpgvectorパッケージは存在しません。インストールするには、Visual StudioのC++と `nmake` を使い、お使いのPostgreSQLのバージョンに合わせてソースからビルドする必要があります（pgvectorの[Windows向け手順](https://github.com/pgvector/pgvector#windows)を参照）。Windowsでのより簡単な方法は、上記の[設定](#2-設定)に示した `pgvector/pgvector` コンテナでデータベースを実行することです。このイメージには拡張機能がプレインストールされています。
:::

pgvectorがなくてもボットは動作しますが、RAG機能は完全に利用できなくなります。この拡張機能は、バックアップを復元する前にターゲットデータベースにも必要です。詳細については[安全な移行](/ja/self-hosting/safe-migration/)を参照してください。

### `pg_cron` : スケジュールされたクリーンアップジョブ

`pg_cron` は、オプションの定期的なデータベースメンテナンス（クールダウン/リマインダー行のクリーンアップ）を強力にサポートします。このリポジトリのDocker Composeでは既に設定されています。

:::caution[リマインダーやトリガーには必須ではありません]
`pg_cron` は古い行をクリーンアップするだけであり、**純粋なハウスキーピング**目的です。リマインダーの配信やランダムなトリガーはアプリ自体で実行されるため、これらの機能は `pg_cron` の有無にかかわらず機能します。
:::

自己管理のPostgreSQLの場合は、アクティブな設定ファイルを見つけます。

```sql
SHOW config_file;
```

`postgresql.conf` で拡張機能を有効にします。`shared_preload_libraries` に他のライブラリがすでにリストされている場合は末尾に追加します。

```ini
shared_preload_libraries = 'pg_cron'   # 例: 'pg_stat_statements,pg_cron'
cron.database_name = 'your_dbname'
```

PostgreSQLを再起動した後、以下を実行します。

```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
```

### トークナイザーアセット : モデルを意識したロジットバイアス

ロジットバイアス（絵文字/単語の繰り返しペナルティ）にはローカルのトークナイザーアセットが必要です。

```sh
bun run setup:tokenizers
```

一部のファミリー（例: Gemma）はゲートで保護されており、ライセンスに同意した後に[HuggingFaceトークン](https://huggingface.co/settings/tokens)が必要です。

```sh
# Windows (PowerShell)
$env:HF_TOKEN="hf_xxx"; bun run setup:tokenizers

# macOS/Linux
HF_TOKEN=hf_xxx bun run setup:tokenizers
```

この手順を行わないとロジットバイアスは暗黙のうちに無効化されますが、その他のすべては正常に動作します。

安全な `fetch_url` フォールバックはプロセス内で実行されるため、Pythonパッケージは不要です。DuckDuckGo/IAskの `web_search` も `bun install --frozen-lockfile` に含まれているため、追加のインストールは不要です。

## メンテナンス、更新とバックアップ

インストールが完了したら、ホスト側のスクリプト（`bun run update`、`bun run backup`、`bun run restore-backup`、`bun run nuke-db`、`bun run rotate-keys` など）、および更新とバックアップの手順はすべて[メンテナンスとバックアップ](/ja/self-hosting/maintenance/)ページにあります。新しいバージョンをプルする前に、まずは[安全な移行](/ja/self-hosting/safe-migration/)から始めてください。
