---
title: "ローカルのGrafanaモニタリング"
sidebar:
  order: 7
---

提供されているDocker Composeプロファイルを使用すると、GrafanaダッシュボードでローカルのTomoriBotインスタンスを監視できます。

お使いのマシンでTomoriBotとGrafanaを一緒に起動するには、以下のコマンドを実行します。

```sh
docker compose -f docker-compose.yaml -f docker/compose.monitor.yaml up -d
```

これにより、以下の処理が行われます。
- PostgreSQLを使用してTomoriBotを起動（DBはポート15432）
- 自動設定されたPostgreSQLデータソースを使用してポート3000でGrafanaを起動
- **TomoriBot Overview** ダッシュボードをプロビジョニング
- 同じDockerネットワーク上で両方のサービスを接続

[http://localhost:3000](http://localhost:3000) でGrafanaにアクセスします。
- **Username**: `admin`
- **Password**: `.env` の `GRAFANA_PASSWORD` で設定（未設定の場合はデフォルトで `admin`）

## プロビジョニング済みダッシュボード

**TomoriBot Overview** は自動的に表示され、設定は不要です。パネルの内容は、プロセスメモリ、キャッシュのエントリ数、時間あたりのエラー数、モデル別のトークン消費、時間帯別のアクティビティ、よく使われるコマンド、ユーザーのロケール、表情クラウド、使用中のプリセットとモデルです。

すべてのパネルは、どの環境にも存在するテーブルのみを読み取ります。そのため、同じダッシュボードがセルフホスト環境でもクラウド環境でも動作します。

次のパネルは、データ元を有効にするまで空のままです。

| パネル | 必要な設定 |
|---|---|
| Process Memory、Cache Entries | `metric_samples` の行。`CACHE_METRICS_INTERVAL_MS` ごとに書き込まれます。コレクタは `RUN_ENV=production` のときのみ動作するため、開発環境では何も表示されません。 |
| Errors per Hour by Type | `ERROR_DB_LOGGING_ENABLED`（既定で有効）。障害が疑われる場面でグラフが平坦な場合、エラーが止まったのではなく、リポジトリのサーキットブレーカーが開いている可能性もあります。 |
| Host Memory and Swap Tiers、Host Pressure (PSI) and Swap-In Rate | Linuxホストが必要です。これらは `/proc/meminfo`、`/proc/pressure/*`、`/proc/swaps`、`/sys/block/zram0` を読み取るため、macOSとWindowsでは空のままです。zramの系列にはzramスワップデバイスも必要ですが、デバイスがないホストでもメモリとPSIは記録されます。 |

## 編集内容の保存

ダッシュボードはUI上で編集できます。これは障害対応時に重要です。ただし編集内容はコンテナ内にのみ保存され、次回の再起動時にディスクの内容で置き換えられます。変更を残すには、ダッシュボードのJSONをエクスポートして `docker/grafana/dashboards/` にコミットしてください。

独自のダッシュボードを追加する場合も、同じディレクトリにJSONファイルを置きます。データソースは固定のuid `tomoribot-postgres` で参照してください。データソースにuidが指定されていない場合、Grafanaはランダムなuidを割り当てます。ランダムなuidを指すダッシュボードは、エラーにならず空のパネルとして表示されます。
