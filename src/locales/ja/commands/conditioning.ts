export default {
  conditioning: {
    description: `ご褒美・おしおきの条件付け記憶を管理します。`,
    shared: {
      select_persona_title: `管理するペルソナを選択`,
      reason_line: `理由: \`\`{reason}\`\``,
      reward_footer: `❤️ {bot}はこれを覚えておきます。管理は /conditioning remove を使用してください。`,
      punish_footer: `💀 {bot}はこれを覚えておきます。管理は /conditioning remove を使用してください。`,
      persona_access_blocked_title: `利用できるペルソナがありません`,
      persona_access_blocked_description: `現在のホワイトリスト権限と個人スポットライト設定では、このチャンネルでこの操作に使えるペルソナがありません。`,
      marker_reward: `❤️`,
      marker_punish: `💀`,
      option_reason_description: `合計 {count} 回 • 理由: 「{reason}」`,
      option_reason_description_single: `理由: 「{reason}」`,
      option_label: `{type_marker} {persona_name} • {action}`,
    },
    manage: {
      description: `このサーバー内の全ペルソナに注入対象の条件付け履歴を管理します。`,
    },
  },
};
