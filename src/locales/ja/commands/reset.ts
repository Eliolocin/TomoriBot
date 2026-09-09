export default {
  reset: {
    description: "サーバーまたは個人設定を既定値に戻します。",
    config: {
      description: "このサーバーの設定をデータベースの既定値に戻します。",
      confirm_title: "サーバー設定をリセット",
      confirm_description:
        "> サーバー設定をデータベースの既定値に戻します。\n> 作成したプロンプト、メモ、タグ一覧はリセットされます。\n\n> 対象項目:\n> • ペルソナ: 0項目（すべてのペルソナを保持）\n> • 動作: 9項目（システムプロンプト、メモ、トリガー）\n> • チャンネル: 6項目（チャンネルルール、自動トリガー）\n> • 権限: 11項目（機能、権限）\n> • モデル: 3項目（サンプラー、フォールバック。IDは保持）\n\n変更されない項目:\n> ペルソナ: {persona_remove}\n> メモリー: {memories} または {personal_memories}\n> プロバイダー: {providers} または {personal_providers}\n> スケジュールタスク: {scheduled_task_remove}\n> サーバーの完全消去: {nuke}\n記録済みのクォータ消費量と外部連携もそのまま保持されます。",
      confirm_button: "設定をリセット",
      no_permission_title: "権限がありません",
      no_permission_description: "このサーバーの設定をリセットするには、サーバー管理権限が必要です。",
      no_server_data_title: "サーバーデータなし",
      no_server_data_description: "このサーバーの設定が見つかりませんでした。",
      success_title: "設定をリセットしました",
      success_description: "サーバー設定をデータベースの既定値に戻しました。",
    },
    personal: {
      description: "個人設定を管理します。",
      config: {
        description: "個人設定をデータベースの既定値に戻します。",
        confirm_title: "個人設定をリセット",
        confirm_description:
          "> 個人設定をデータベースの既定値に戻します。\n\n> 対象項目:\n> • プロフィール: ニックネーム、外見、性別、代名詞\n> • プライバシー: プライバシーレベル、サーバー間共有の同意\n> • 詳細設定: 応答モード、なりすまし、スポットライト\n> • モデル: 0項目（すべてのプロバイダー設定を保持）\n\n変更されない項目:\n> プロバイダー: {personal_providers}\n> メモリー: {personal_memories}\n> スケジュールタスク: {scheduled_task_remove}\n保存済みのプロバイダー設定、カスタムエンドポイント、その他の個人データはそのまま保持されます。",
        confirm_button: "設定をリセット",
        success_title: "個人設定をリセットしました",
        success_description: "個人設定とチャンネルのスポットライトをデータベースの既定値に戻しました。",
      },
    },
  },
};
