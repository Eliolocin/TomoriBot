export default {
  conditioning: {
    description: `ご褒美・おしおきの条件付け記憶を管理します。`,
    shared: {
      select_persona_title: `管理するペルソナを選択`,
      reason_line: `理由: \`\`{reason}\`\``,
      reward_footer: `❤️ {bot}はこれを覚えておきます。管理は /conditioning manage を使用してください。`,
      punish_footer: `💀 {bot}はこれを覚えておきます。管理は /conditioning manage を使用してください。`,
      persona_access_blocked_title: `利用できるペルソナがありません`,
      persona_access_blocked_description: `現在のホワイトリスト権限と個人スポットライト設定では、このチャンネルでこの操作に使えるペルソナがありません。`,
    },
    manage: {
      description: `このサーバー内の全ペルソナに注入対象の条件付け履歴を管理します。`,
      marker_reward: `❤️`,
      marker_punish: `💀`,
      none_title: `管理する条件付けはありません`,
      none_description: `このサーバーには管理できる注入対象の条件付け履歴がありません。`,
      too_many_title: `項目が多すぎます`,
      too_many_description: `{total_entries} 件の項目が見つかりました（{total_pages} ページ）。現在は最大 {max_pages} ページまで対応しています。`,
      select_page_title: `条件付けページを選択`,
      select_page_description: `管理したい注入対象の条件付け項目のページを選択してください。
項目数: {total_entries}
ページ数: {total_pages}
各項目にはペルソナ名とご褒美/おしおき種別が表示されます。`,
      checkbox_label: `条件付け項目`,
      checkbox_label_continued: `条件付け項目（続き）`,
      checkbox_description: `チェックを残すと保持されます。チェックを外すと、その注入対象の条件付けグループが削除されます。`,
      option_reason_description: `合計 {count} 回 • 理由: 「{reason}」`,
      option_reason_description_single: `理由: 「{reason}」`,
      option_label: `{type_marker} {persona_name} • {action}`,
      modal_title: `条件付けを管理`,
      done_button: `完了`,
      no_changes_title: `変更はありません`,
      no_changes_description: `すべてチェックされたままだったため、削除は行われませんでした。`,
      success_title: `条件付けを更新しました`,
      success_description: `{persona_count} 個のペルソナにまたがるご褒美グループ {reward_groups} 件、おしおきグループ {punish_groups} 件を削除しました（保存行 {deleted_rows} 件を削除）。`,
    },
  },
};
