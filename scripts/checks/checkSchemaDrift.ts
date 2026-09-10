import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface Issue {
  check: string;
  message: string;
}

const issueList: Issue[] = [];

// Intentional export exclusions: these tables hold resettable telemetry/counters,
// not portable server/persona configuration. stat_counters is the same class of
// high-frequency runtime telemetry (it omits the `_runtime_state` suffix only
// because it is a per-day counter table, not a single-row state row).
const RUNTIME_STATE_EXPORT_EXCLUDED_TABLES = new Set([
  "api_key_rotation_runtime_state",
  "persona_autoch_runtime_state",
  "stat_counters",
]);

function addIssue(check: string, message: string): void {
  issueList.push({ check, message });
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function findStatementEnd(content: string, startIndex: number): number {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = startIndex; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "{" || char === "[") {
      depth++;
      continue;
    }

    if (char === ")" || char === "}" || char === "]") {
      depth--;
      continue;
    }

    if (char === ";" && depth === 0) {
      return i;
    }
  }

  return -1;
}

function extractObjectKeysFromBody(body: string): Set<string> {
  const keys = new Set<string>();
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let lineStart = 0;
  let lineStartDepth = 0;

  for (let i = 0; i <= body.length; i++) {
    const char = body[i] ?? "\n";

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "{" || char === "[") {
      depth++;
    } else if (char === ")" || char === "}" || char === "]") {
      depth--;
    } else if (char === "\n") {
      if (lineStartDepth === 0) {
        const line = body.slice(lineStart, i);
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/);
        if (match) keys.add(match[1]);
      }
      lineStart = i + 1;
      lineStartDepth = depth;
    }
  }

  return keys;
}

function findConstDeclarationIndex(content: string, name: string, initializerPattern = ""): number {
  const declaration = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*${initializerPattern}`).exec(content);
  return declaration?.index ?? -1;
}

function extractDirectZodObjectKeys(content: string, exportName: string): Set<string> | null {
  const declarationIndex = findConstDeclarationIndex(content, exportName, "z\\.object\\(");
  if (declarationIndex === -1) return null;

  const openIndex = content.indexOf("{", declarationIndex);
  if (openIndex === -1) {
    addIssue("zod-schema", `Could not find opening object brace for ${exportName}`);
    return new Set();
  }

  const closeIndex = findMatchingBrace(content, openIndex);
  if (closeIndex === -1) {
    addIssue("zod-schema", `Could not find closing object brace for ${exportName}`);
    return new Set();
  }

  return extractObjectKeysFromBody(content.slice(openIndex + 1, closeIndex));
}

function extractComposedZodObjectKeys(content: string, exportName: string, seen: Set<string>): Set<string> | null {
  const declarationIndex = findConstDeclarationIndex(content, exportName);
  if (declarationIndex === -1) return null;

  const statementEnd = findStatementEnd(content, declarationIndex);
  if (statementEnd === -1) {
    addIssue("zod-schema", `Could not find statement end for ${exportName}`);
    return new Set();
  }

  const statement = content.slice(declarationIndex, statementEnd);
  const omittedSharedKeys = new Set(["server_id", "created_at", "updated_at"]);
  const omittedSchemaRefs = Array.from(
    statement.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.omit\(_sharedOmit\)/g),
    (match) => match[1],
  );
  const omittedInlineKeysBySchema = new Map<string, Set<string>>();
  for (const match of statement.matchAll(/\.omit\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const schemaStart = statement.slice(0, match.index).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1];
    if (!schemaStart) continue;
    const omittedInlineKeys = omittedInlineKeysBySchema.get(schemaStart) ?? new Set<string>();
    for (const key of match[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      omittedInlineKeys.add(key[1]);
    }
    omittedInlineKeysBySchema.set(schemaStart, omittedInlineKeys);
  }
  const pickedInlineKeysBySchema = new Map<string, Set<string>>();
  for (const match of statement.matchAll(/\.pick\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    const schemaStart = statement.slice(0, match.index).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1];
    if (!schemaStart) continue;
    const pickedInlineKeys = pickedInlineKeysBySchema.get(schemaStart) ?? new Set<string>();
    for (const key of match[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      pickedInlineKeys.add(key[1]);
    }
    pickedInlineKeysBySchema.set(schemaStart, pickedInlineKeys);
  }
  const directSchemaRefs = [
    ...Array.from(statement.matchAll(/=\s*([A-Za-z_][A-Za-z0-9_]*)\b/g), (match) => match[1]),
    ...Array.from(statement.matchAll(/\.merge\(\s*([A-Za-z_][A-Za-z0-9_]*)\b/g), (match) => match[1]),
  ];

  if (omittedSchemaRefs.length === 0 && directSchemaRefs.length === 0) return null;

  const keys = new Set<string>();
  for (const schemaRef of directSchemaRefs) {
    const schemaKeys = extractZodObjectKeys(content, schemaRef, seen);
    const omittedInlineKeys = omittedInlineKeysBySchema.get(schemaRef) ?? new Set<string>();
    const pickedInlineKeys = pickedInlineKeysBySchema.get(schemaRef);
    for (const key of schemaKeys) {
      if (!omittedInlineKeys.has(key) && (!pickedInlineKeys || pickedInlineKeys.has(key))) keys.add(key);
    }
  }

  for (const schemaRef of omittedSchemaRefs) {
    const schemaKeys = extractZodObjectKeys(content, schemaRef, seen);
    const omittedInlineKeys = omittedInlineKeysBySchema.get(schemaRef) ?? new Set<string>();
    const pickedInlineKeys = pickedInlineKeysBySchema.get(schemaRef);
    for (const key of schemaKeys) {
      if (
        !omittedSharedKeys.has(key) &&
        !omittedInlineKeys.has(key) &&
        (!pickedInlineKeys || pickedInlineKeys.has(key))
      ) {
        keys.add(key);
      }
    }
  }

  const extendIndex = statement.lastIndexOf(".extend(");
  if (extendIndex !== -1) {
    const openIndex = statement.indexOf("{", extendIndex);
    const closeIndex = openIndex === -1 ? -1 : findMatchingBrace(statement, openIndex);
    if (openIndex === -1 || closeIndex === -1) {
      addIssue("zod-schema", `Could not parse .extend() block for ${exportName}`);
    } else {
      for (const key of extractObjectKeysFromBody(statement.slice(openIndex + 1, closeIndex))) {
        keys.add(key);
      }
    }
  }

  return keys;
}

function extractZodObjectKeys(content: string, exportName: string, seen = new Set<string>()): Set<string> {
  if (seen.has(exportName)) return new Set();
  seen.add(exportName);

  const directKeys = extractDirectZodObjectKeys(content, exportName);
  if (directKeys) return directKeys;

  const composedKeys = extractComposedZodObjectKeys(content, exportName, seen);
  if (composedKeys) return composedKeys;

  addIssue("zod-schema", `Could not find Zod object ${exportName}`);
  return new Set();
}

function extractMethodBody(content: string, methodName: string): string | null {
  const declaration = new RegExp(`\\basync\\s+${methodName}\\s*\\(`).exec(content);
  if (!declaration) return null;

  const openIndex = content.indexOf("{", declaration.index);
  if (openIndex === -1) {
    addIssue("v2-config-export", `Could not find method body for ${methodName}`);
    return "";
  }

  const closeIndex = findMatchingBrace(content, openIndex);
  if (closeIndex === -1) {
    addIssue("v2-config-export", `Could not find closing method brace for ${methodName}`);
    return "";
  }

  return content.slice(openIndex + 1, closeIndex);
}

function extractConfigExclusionReasons(content: string): Map<string, string> {
  const declarationIndex = findConstDeclarationIndex(content, "V2_CONFIG_EXCLUSIONS");
  if (declarationIndex === -1) {
    addIssue("v2-config-export", "Could not find V2_CONFIG_EXCLUSIONS");
    return new Map();
  }

  const openIndex = content.indexOf("{", declarationIndex);
  const closeIndex = openIndex === -1 ? -1 : findMatchingBrace(content, openIndex);
  if (openIndex === -1 || closeIndex === -1) {
    addIssue("v2-config-export", "Could not parse V2_CONFIG_EXCLUSIONS");
    return new Map();
  }

  const reasons = new Map<string, string>();
  const body = content.slice(openIndex + 1, closeIndex);
  const entries = body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{([\s\S]*?)^\s*\},?/gm);
  for (const entry of entries) {
    const reason = entry[2].match(/\breason\s*:\s*"([^"]*)"/)?.[1];
    if (reason) reasons.set(entry[1], reason);
  }

  return reasons;
}

function countTopLevelListItems(list: string): number {
  const trimmed = list.trim();
  if (!trimmed) return 0;

  let count = 1;
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < list.length; i++) {
    const char = list[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") {
      depth++;
      continue;
    }

    if (char === ")" || char === "]" || char === "}") {
      depth--;
      continue;
    }

    if (char === "," && depth === 0) {
      count++;
    }
  }

  return count;
}

function extractInsertBlocks(content: string, tableName: string): Array<{ columns: string; values: string }> {
  const blocks: Array<{ columns: string; values: string }> = [];
  const insertPattern = new RegExp(`INSERT\\s+INTO\\s+${tableName}\\s*\\(`, "gi");
  let match = insertPattern.exec(content);

  while (match) {
    const columnsOpenIndex = content.indexOf("(", match.index);
    const columnsCloseIndex = findMatchingParen(content, columnsOpenIndex);
    const valuesIndex = content.indexOf("VALUES", columnsCloseIndex);

    if (columnsCloseIndex === -1 || valuesIndex === -1) {
      addIssue("sql-insert", `Could not parse INSERT block for ${tableName} near index ${match.index}`);
      match = insertPattern.exec(content);
      continue;
    }

    const valuesOpenIndex = content.indexOf("(", valuesIndex);
    const valuesCloseIndex = findMatchingParen(content, valuesOpenIndex);
    if (valuesOpenIndex === -1 || valuesCloseIndex === -1) {
      addIssue("sql-insert", `Could not parse VALUES block for ${tableName} near index ${match.index}`);
      match = insertPattern.exec(content);
      continue;
    }

    blocks.push({
      columns: content.slice(columnsOpenIndex + 1, columnsCloseIndex),
      values: content.slice(valuesOpenIndex + 1, valuesCloseIndex),
    });
    match = insertPattern.exec(content);
  }

  return blocks;
}

function findMatchingParen(content: string, openIndex: number): number {
  if (openIndex === -1) return -1;

  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = openIndex; i < content.length; i++) {
    const char = content[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "(") {
      depth++;
      continue;
    }

    if (char === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function hasSchemaSqlColumn(schemaSql: string, tableName: string, columnName: string): boolean {
  const createPattern = new RegExp(
    `CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${tableName}\\s*\\(([\\s\\S]*?)\\n\\);`,
    "i",
  );
  const createMatch = schemaSql.match(createPattern);
  const inCreate = Boolean(createMatch?.[1].match(new RegExp(`(^|\\n)\\s*${columnName}\\s+`, "i")));
  const inMigration =
    schemaSql.includes(`add_column_if_not_exists('${tableName}', '${columnName}'`) ||
    schemaSql.match(
      new RegExp(`add_column_if_not_exists\\(\\s*['"]${tableName}['"]\\s*,\\s*['"]${columnName}['"]`, "i"),
    ) !== null;

  return inCreate || inMigration;
}

function checkInsertCounts(dbWrite: string, tableName: string): void {
  const blocks = extractInsertBlocks(dbWrite, tableName);
  if (blocks.length === 0) {
    addIssue("sql-insert", `No INSERT INTO ${tableName} blocks found in dbWrite.ts`);
    return;
  }

  blocks.forEach((block, index) => {
    const columnCount = countTopLevelListItems(block.columns);
    const valueCount = countTopLevelListItems(block.values);
    if (columnCount !== valueCount) {
      addIssue(
        "sql-insert",
        `${tableName} INSERT #${index + 1} has ${columnCount} target columns but ${valueCount} VALUES expressions`,
      );
    }
  });
}

// Export keys that are produced as nested objects/arrays by a dedicated repository
// (ShortTermMemoryRepository.toExportShape) rather than flat SQL column SELECTs and a
// per-table column export schema. They are still emitted by ExportRepository and
// restored by ImportRepository (both verified below), so only the flat-column SELECT
// alias and per-table composition rules are exempted for them.
const REPOSITORY_SOURCED_EXPORT_KEYS = new Set(["stm_config", "stm_categories"]);

function checkExportImportMappings(
  exportKeys: Set<string>,
  dataExportContent: string,
  dataImportContent: string,
): void {
  for (const key of exportKeys) {
    // Repository-sourced nested exports have no `as <key>` SQL alias; skip that rule
    // only (the emit + import-restore rules below still apply).
    if (!REPOSITORY_SOURCED_EXPORT_KEYS.has(key) && !dataExportContent.match(new RegExp(`\\bas\\s+${key}\\b`, "i"))) {
      addIssue(
        "server-config-export",
        `serverConfigExportSchema includes ${key}, but ExportRepository.ts does not SELECT it`,
      );
    }

    if (!dataExportContent.match(new RegExp(`\\b${key}\\s*:`))) {
      addIssue(
        "server-config-export",
        `serverConfigExportSchema includes ${key}, but ExportRepository.ts does not emit it`,
      );
    }

    if (
      !dataImportContent.match(new RegExp(`\\b${key}\\s*=`)) &&
      !dataImportContent.match(new RegExp(`\\b${key}\\s*:`))
    ) {
      addIssue(
        "server-config-import",
        `serverConfigExportSchema includes ${key}, but ImportRepository.ts does not restore it`,
      );
    }
  }
}

type ServerConfigExportCoverageTarget = {
  tableName: string;
  rowSchemaName?: string;
  exportSchemaName: string;
  sourceKeys?: string[];
  excludedKeys?: string[];
};

const SHARED_CONFIG_TABLE_KEYS = new Set(["server_id", "created_at", "updated_at"]);

const SERVER_CONFIG_EXPORT_COVERAGE_TARGETS: ServerConfigExportCoverageTarget[] = [
  {
    tableName: "server_model_configs",
    rowSchemaName: "serverModelConfigSchema",
    exportSchemaName: "serverModelConfigExportSchema",
    excludedKeys: [
      // Model/provider selection is environment-specific and must be reconfigured after import.
      "llm_id",
      "embedding_model_id",
      "diffusion_model_id",
      "video_model_id",
      "vision_llm_id",
      // Security-sensitive encrypted credential mirrors are never exported.
      "api_key",
      "key_version",
      // Deprecated migration/compatibility fields are not part of portable config.
      "custom_endpoint_url",
      "custom_model_name",
      "custom_num_ctx",
      "fallback_llm_ids",
      "other_model_codename",
      "other_model_capabilities",
      "other_model_capabilities_fetched_at",
      "hide_respond_embed",
    ],
  },
  {
    tableName: "server_chat_configs",
    rowSchemaName: "serverChatConfigSchema",
    exportSchemaName: "serverChatConfigExportSchema",
    excludedKeys: [
      // Fallback refs contain server-local model/custom-endpoint pointers.
      "fallback_model_refs",
    ],
  },
  {
    tableName: "server_member_permissions_configs",
    rowSchemaName: "serverMemberPermissionsConfigSchema",
    exportSchemaName: "serverMemberPermissionsConfigExportSchema",
    excludedKeys: [
      // Legacy migration source superseded by server_notice_embeds_configs.tool_notice_hidden_keys.
      "hide_impersonation_embeds",
    ],
  },
  {
    tableName: "server_capabilities_configs",
    rowSchemaName: "serverCapabilitiesConfigSchema",
    exportSchemaName: "serverCapabilitiesConfigExportSchema",
  },
  {
    tableName: "server_notice_embeds_configs",
    rowSchemaName: "serverNoticeEmbedsConfigSchema",
    exportSchemaName: "serverNoticeEmbedsConfigExportSchema",
  },
  {
    tableName: "server_nsfw_configs",
    rowSchemaName: "serverNsfwConfigSchema",
    exportSchemaName: "serverNsfwConfigExportSchema",
  },
  {
    tableName: "server_speech_configs",
    rowSchemaName: "serverSpeechConfigSchema",
    exportSchemaName: "serverSpeechConfigExportSchema",
  },
  {
    tableName: "server_auto_trigger_configs",
    rowSchemaName: "serverAutoTriggerConfigSchema",
    exportSchemaName: "serverAutoTriggerConfigExportSchema",
    excludedKeys: [
      // Discord channel IDs and channel-coupled thresholds are server-specific.
      "autoch_disc_ids",
      "autoch_threshold",
      "autoch_threshold_max",
      // Junction-owned override data references server-local personas/channels.
      "autoch_persona_overrides",
    ],
  },
  {
    tableName: "server_channel_scope_configs",
    rowSchemaName: "serverChannelScopeConfigSchema",
    exportSchemaName: "serverChannelScopeConfigExportSchema",
    excludedKeys: [
      // Discord channel IDs are not portable across servers.
      "rp_channel_ids",
      "private_channel_ids",
      "crosschannel_blocklist_ids",
      "thought_log_channel_disc_id",
    ],
  },
  {
    tableName: "server_trigger_behavior_configs",
    rowSchemaName: "serverTriggerBehaviorConfigSchema",
    exportSchemaName: "serverTriggerBehaviorConfigExportSchema",
  },
  {
    tableName: "server_novelai_imagegen_configs",
    rowSchemaName: "serverNovelaiImagegenConfigSchema",
    exportSchemaName: "serverNovelaiImagegenConfigExportSchema",
    excludedKeys: [
      // Model/provider selection is environment-specific and must be reconfigured after import.
      "nai_diffusion_model_id",
    ],
  },
  {
    tableName: "server_byok_configs",
    rowSchemaName: "serverByokConfigSchema",
    exportSchemaName: "serverByokConfigExportSchema",
  },
  {
    tableName: "server_memory_configs",
    rowSchemaName: "serverMemoryConfigSchema",
    exportSchemaName: "serverMemoryConfigExportSchema",
  },
  {
    tableName: "server_welcome_configs",
    exportSchemaName: "serverWelcomeConfigExportSchema",
    sourceKeys: [
      "server_id",
      "welcome_channel_disc_id",
      "welcome_prompt",
      "welcome_persona_id",
      "created_at",
      "updated_at",
    ],
    excludedKeys: [
      // Discord channel IDs and persona FKs are server-specific.
      "welcome_channel_disc_id",
      "welcome_persona_id",
    ],
  },
];

type ConfigProjectionScope = "workspace" | "personal";

type ConfigProjectionCoverageTarget = {
  scope: ConfigProjectionScope;
  tableName: string;
  rowSchemaName?: string;
  exportSchemaName: string;
  sourceKeys?: string[];
  supplementalSourceKeys?: string[];
  sourceToExportKey?: Record<string, string>;
  excludedKeys?: string[];
};

const V2_CONFIG_SECTION_SCHEMA_NAMES: Record<ConfigProjectionScope, Record<string, string>> = {
  workspace: {
    chat: "workspaceChatConfigSectionSchema",
    triggers: "workspaceTriggersConfigSectionSchema",
    capabilities: "workspaceCapabilitiesConfigSectionSchema",
    memory: "workspaceMemoryConfigSectionSchema",
    media: "workspaceMediaConfigSectionSchema",
    speech: "workspaceSpeechConfigSectionSchema",
    access: "workspaceAccessConfigSectionSchema",
  },
  personal: {
    profile: "personalProfileConfigSectionSchema",
    privacy: "personalPrivacyConfigSectionSchema",
    appearance: "personalAppearanceConfigSectionSchema",
    response_modes: "personalResponseModesConfigSectionSchema",
  },
};

const V1_CONFIG_SCHEMA_NAMES: Record<ConfigProjectionScope, string[]> = {
  workspace: [
    "serverModelConfigExportSchema",
    "serverChatConfigExportSchema",
    "serverMemberPermissionsConfigExportSchema",
    "serverCapabilitiesConfigExportSchema",
    "serverNoticeEmbedsConfigExportSchema",
    "serverNsfwConfigExportSchema",
    "serverSpeechConfigExportSchema",
    "serverAutoTriggerConfigExportSchema",
    "serverChannelScopeConfigExportSchema",
    "serverTriggerBehaviorConfigExportSchema",
    "serverNovelaiImagegenConfigExportSchema",
    "serverByokConfigExportSchema",
    "serverMemoryConfigExportSchema",
    "serverWelcomeConfigExportSchema",
    "serverStmConfigExportSchema",
  ],
  personal: ["personalSettingsExportDataSchema"],
};

const CONFIG_PROJECTION_TARGETS: ConfigProjectionCoverageTarget[] = [
  ...SERVER_CONFIG_EXPORT_COVERAGE_TARGETS.map((target) => ({
    scope: "workspace" as const,
    tableName: target.tableName,
    rowSchemaName: target.rowSchemaName,
    exportSchemaName: target.exportSchemaName,
    sourceKeys: target.sourceKeys,
    excludedKeys: target.excludedKeys,
  })),
  {
    scope: "workspace",
    tableName: "server_stm_configs",
    rowSchemaName: "serverStmConfigSchema",
    exportSchemaName: "serverStmConfigExportSchema",
    sourceToExportKey: {
      refresh_cadence: "stm_config",
      render_mode: "stm_config",
      crude_message_count: "stm_config",
      tool_description_override: "stm_config",
      update_nudge_override: "stm_config",
      nudge_injection_depth: "stm_config",
      content_injection_depth: "stm_config",
    },
  },
  {
    scope: "workspace",
    tableName: "stm_categories",
    rowSchemaName: "stmCategorySchema",
    exportSchemaName: "serverStmConfigExportSchema",
    sourceToExportKey: {
      position: "stm_categories",
      label: "stm_categories",
      description: "stm_categories",
    },
  },
  {
    scope: "personal",
    tableName: "user_personalization_configs",
    rowSchemaName: "userPersonalizationConfigsSchema",
    exportSchemaName: "personalSettingsExportDataSchema",
    supplementalSourceKeys: ["language_pref", "privacy_level"],
  },
];

const CONFIG_COLUMN_EXCLUSION_REASONS: Record<string, string> = {
  "server_model_configs.server_id": "The database key identifies the source workspace.",
  "server_model_configs.llm_id": "The selected model is deployment-specific.",
  "server_model_configs.embedding_model_id": "The selected embedding model is deployment-specific.",
  "server_model_configs.diffusion_model_id": "The selected diffusion model is deployment-specific.",
  "server_model_configs.video_model_id": "The selected video model is deployment-specific.",
  "server_model_configs.vision_llm_id": "The selected vision model is deployment-specific.",
  "server_model_configs.api_key": "Encrypted credentials are never portable.",
  "server_model_configs.key_version": "Credential metadata has no portable meaning.",
  "server_model_configs.custom_endpoint_url": "Custom endpoints are deployment-specific.",
  "server_model_configs.custom_model_name": "Custom model names are deployment-specific.",
  "server_model_configs.custom_num_ctx": "Custom context settings belong to a deployment-specific model.",
  "server_model_configs.fallback_llm_ids": "Fallback model identifiers are deployment-specific.",
  "server_model_configs.other_model_codename": "The legacy model codename is deployment-specific.",
  "server_model_configs.other_model_capabilities": "Legacy model capabilities describe a deployment-specific model.",
  "server_model_configs.other_model_capabilities_fetched_at": "Legacy model capability timestamps are runtime metadata.",
  "server_model_configs.hide_respond_embed": "The legacy response flag is not portable configuration.",
  "server_model_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_model_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_chat_configs.server_id": "The database key identifies the source workspace.",
  "server_chat_configs.fallback_model_refs": "Fallback model references are deployment-specific.",
  "server_chat_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_chat_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_member_permissions_configs.server_id": "The database key identifies the source workspace.",
  "server_member_permissions_configs.hide_impersonation_embeds": "The legacy notice flag was superseded by the notice table.",
  "server_member_permissions_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_member_permissions_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_capabilities_configs.server_id": "The database key identifies the source workspace.",
  "server_capabilities_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_capabilities_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_notice_embeds_configs.server_id": "The database key identifies the source workspace.",
  "server_notice_embeds_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_notice_embeds_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_nsfw_configs.server_id": "The database key identifies the source workspace.",
  "server_nsfw_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_nsfw_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_speech_configs.server_id": "The database key identifies the source workspace.",
  "server_speech_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_speech_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_auto_trigger_configs.server_id": "The database key identifies the source workspace.",
  "server_auto_trigger_configs.autoch_disc_ids": "Discord channel identifiers are source-workspace specific.",
  "server_auto_trigger_configs.autoch_persona_overrides": "Persona and channel references are source-workspace specific.",
  "server_auto_trigger_configs.autoch_threshold": "Automatic trigger thresholds are coupled to source channels.",
  "server_auto_trigger_configs.autoch_threshold_max": "Automatic trigger thresholds are coupled to source channels.",
  "server_auto_trigger_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_auto_trigger_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_channel_scope_configs.server_id": "The database key identifies the source workspace.",
  "server_channel_scope_configs.rp_channel_ids": "Discord channel identifiers are source-workspace specific.",
  "server_channel_scope_configs.private_channel_ids": "Discord channel identifiers are source-workspace specific.",
  "server_channel_scope_configs.crosschannel_blocklist_ids": "Discord channel identifiers are source-workspace specific.",
  "server_channel_scope_configs.thought_log_channel_disc_id": "Discord channel identifiers are source-workspace specific.",
  "server_channel_scope_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_channel_scope_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_trigger_behavior_configs.server_id": "The database key identifies the source workspace.",
  "server_trigger_behavior_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_trigger_behavior_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_novelai_imagegen_configs.server_id": "The database key identifies the source workspace.",
  "server_novelai_imagegen_configs.nai_diffusion_model_id": "The selected diffusion model is deployment-specific.",
  "server_novelai_imagegen_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_novelai_imagegen_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_byok_configs.server_id": "The database key identifies the source workspace.",
  "server_byok_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_byok_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_memory_configs.server_id": "The database key identifies the source workspace.",
  "server_memory_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_memory_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_welcome_configs.server_id": "The database key identifies the source workspace.",
  "server_welcome_configs.welcome_channel_disc_id": "Discord channel identifiers are source-workspace specific.",
  "server_welcome_configs.welcome_persona_id": "Persona identifiers are source-workspace specific.",
  "server_welcome_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_welcome_configs.updated_at": "Update timestamps are runtime metadata.",
  "server_stm_configs.server_id": "The database key identifies the source workspace.",
  "server_stm_configs.created_at": "Creation timestamps are runtime metadata.",
  "server_stm_configs.updated_at": "Update timestamps are runtime metadata.",
  "stm_categories.stm_category_id": "The database key identifies the source category row.",
  "stm_categories.server_id": "The database key identifies the source workspace.",
  "user_personalization_configs.user_id": "The database key identifies the source user.",
  "user_personalization_configs.nai_char_ref_url": "The reference URL depends on the source deployment.",
  "user_personalization_configs.created_at": "Creation timestamps are runtime metadata.",
  "user_personalization_configs.updated_at": "Update timestamps are runtime metadata.",
};

function checkServerConfigExportComposition(
  schemaContent: string,
  dataExportContent: string,
  composedExportKeys: Set<string>,
): void {
  const composedFromSlices = new Set<string>();

  for (const target of SERVER_CONFIG_EXPORT_COVERAGE_TARGETS) {
    const sourceKeys = target.sourceKeys
      ? new Set(target.sourceKeys)
      : extractZodObjectKeys(schemaContent, target.rowSchemaName ?? "");
    const exportKeys = extractZodObjectKeys(dataExportContent, target.exportSchemaName);
    const excludedKeys = new Set([...SHARED_CONFIG_TABLE_KEYS, ...(target.excludedKeys ?? [])]);

    for (const key of sourceKeys) {
      if (excludedKeys.has(key)) continue;
      if (!exportKeys.has(key)) {
        addIssue(
          "server-config-export-coverage",
          `${target.tableName}.${key} is neither exported by ${target.exportSchemaName} nor explicitly excluded`,
        );
      }
    }

    for (const key of exportKeys) {
      composedFromSlices.add(key);
      if (!sourceKeys.has(key)) {
        addIssue(
          "server-config-export-coverage",
          `${target.exportSchemaName} exports ${key}, but ${target.tableName} does not define that field`,
        );
      }
      if (excludedKeys.has(key)) {
        addIssue(
          "server-config-export-coverage",
          `${target.exportSchemaName} exports ${key}, but ${target.tableName}.${key} is explicitly excluded`,
        );
      }
    }
  }

  for (const key of composedFromSlices) {
    if (!composedExportKeys.has(key)) {
      addIssue(
        "server-config-export-composition",
        `${key} is exported by a per-table schema but missing from serverConfigExportSchema`,
      );
    }
  }

  for (const key of composedExportKeys) {
    // STM customization is composed from serverStmConfigExportSchema as nested
    // objects, not flat per-table columns, so it is exempt from this rule.
    if (REPOSITORY_SOURCED_EXPORT_KEYS.has(key)) continue;
    if (!composedFromSlices.has(key)) {
      addIssue(
        "server-config-export-composition",
        `${key} is in serverConfigExportSchema but not in any per-table export schema`,
      );
    }
  }
}

function checkV2ConfigProjectionCoverage(
  schemaContent: string,
  dataExportSchemaContent: string,
  dataExportImplementationContent: string,
): void {
  const exclusionReasons = extractConfigExclusionReasons(dataExportSchemaContent);
  const exclusionKeys = new Set(exclusionReasons.keys());
  const sectionFields = new Map<ConfigProjectionScope, Map<string, Set<string>>>();

  for (const scope of ["workspace", "personal"] as const) {
    const fieldsBySection = new Map<string, Set<string>>();
    for (const [section, schemaName] of Object.entries(V2_CONFIG_SECTION_SCHEMA_NAMES[scope])) {
      fieldsBySection.set(section, extractZodObjectKeys(dataExportSchemaContent, schemaName));
    }
    sectionFields.set(scope, fieldsBySection);
  }

  const sectionOwners = (scope: ConfigProjectionScope, field: string): string[] => {
    const fieldsBySection = sectionFields.get(scope);
    if (!fieldsBySection) return [];
    return [...fieldsBySection.entries()]
      .filter(([, fields]) => fields.has(field))
      .map(([section]) => section);
  };

  const allV1FieldsByScope = new Map<ConfigProjectionScope, Set<string>>();
  for (const scope of ["workspace", "personal"] as const) {
    const fields = new Set<string>();
    for (const schemaName of V1_CONFIG_SCHEMA_NAMES[scope]) {
      const schemaFields = extractZodObjectKeys(dataExportSchemaContent, schemaName);
      for (const field of schemaFields) {
        fields.add(field);
        const owners = sectionOwners(scope, field);
        if (exclusionKeys.has(field)) {
          if (owners.length > 0) {
            addIssue(
              "v2-config-ownership",
              `${schemaName}.${field} is explicitly excluded but owned by v2 section(s): ${owners.join(", ")}`,
            );
          }
        } else if (owners.length !== 1) {
          addIssue(
            "v2-config-ownership",
            `${schemaName}.${field} must be owned by exactly one v2 section, found ${owners.length}`,
          );
        }
      }
    }
    allV1FieldsByScope.set(scope, fields);

    for (const [section, sectionKeys] of sectionFields.get(scope) ?? []) {
      for (const field of sectionKeys) {
        if (!fields.has(field)) {
          addIssue(
            "v2-config-ownership",
            `${scope} v2 section ${section} owns ${field}, but no v1 config schema declares it`,
          );
        }
      }
    }
  }

  for (const [field, reason] of exclusionReasons) {
    if (!reason.trim()) {
      addIssue("v2-config-exclusion", `${field} has an empty exclusion reason`);
    }

    const sourceScopes = [...allV1FieldsByScope.entries()]
      .filter(([, fields]) => fields.has(field))
      .map(([scope]) => scope);
    if (sourceScopes.length === 0) {
      addIssue("v2-config-exclusion", `${field} is excluded but is not declared by a v1 config schema`);
    }
  }

  const workspaceProjection = extractMethodBody(dataExportImplementationContent, "exportWorkspaceConfig");
  const personalProjection = extractMethodBody(dataExportImplementationContent, "exportPersonalConfig");
  const projectionBodies: Record<ConfigProjectionScope, string> = {
    workspace: workspaceProjection ?? "",
    personal: personalProjection ?? "",
  };
  if (workspaceProjection === null) addIssue("v2-config-export", "ExportRepository.ts has no exportWorkspaceConfig method");
  if (personalProjection === null) addIssue("v2-config-export", "ExportRepository.ts has no exportPersonalConfig method");

  for (const target of CONFIG_PROJECTION_TARGETS) {
    const sourceKeys = new Set([
      ...(target.sourceKeys ?? (target.rowSchemaName ? extractZodObjectKeys(schemaContent, target.rowSchemaName) : [])),
      ...(target.supplementalSourceKeys ?? []),
    ]);
    const exportKeys = extractZodObjectKeys(dataExportSchemaContent, target.exportSchemaName);
    const projection = projectionBodies[target.scope];

    for (const sourceKey of sourceKeys) {
      const reasonKey = `${target.tableName}.${sourceKey}`;
      const isIdentity =
        sourceKey === "server_id" ||
        sourceKey === "user_id" ||
        sourceKey === "stm_category_id" ||
        sourceKey === "created_at" ||
        sourceKey === "updated_at";
      const isExcluded = isIdentity || target.excludedKeys?.includes(sourceKey) || exclusionKeys.has(sourceKey);
      if (isExcluded) {
        const reason = exclusionKeys.has(sourceKey) ? exclusionReasons.get(sourceKey) : CONFIG_COLUMN_EXCLUSION_REASONS[reasonKey];
        if (!reason?.trim()) {
          addIssue("v2-config-exclusion", `${reasonKey} is excluded but has no named reason`);
        }
        continue;
      }

      const exportKey = target.sourceToExportKey?.[sourceKey] ?? sourceKey;
      if (!exportKeys.has(exportKey)) {
        addIssue(
          "v2-config-export-coverage",
          `${reasonKey} is portable but ${target.exportSchemaName} does not declare ${exportKey}`,
        );
      }

      if (!projection.match(new RegExp(`\\bas\\s+${sourceKey}\\b`, "i"))) {
        addIssue("v2-config-read", `${reasonKey} is portable but exportWorkspaceConfig/exportPersonalConfig does not SELECT it`);
      }
      if (!projection.match(new RegExp(`\\b${sourceKey}\\s*:`, "i"))) {
        addIssue("v2-config-projection", `${reasonKey} is portable but its v2 projection does not emit it`);
      }

      const owners = sectionOwners(target.scope, exportKey);
      if (owners.length !== 1) {
        addIssue(
          "v2-config-ownership",
          `${reasonKey} maps to ${exportKey}, which must be owned by exactly one v2 section, found ${owners.length}`,
        );
      }
    }
  }

  for (const field of exclusionKeys) {
    const owners = [
      ...sectionOwners("workspace", field),
      ...sectionOwners("personal", field),
    ];
    if (owners.length > 0) {
      addIssue("v2-config-ownership", `${field} is excluded but appears in v2 section(s): ${owners.join(", ")}`);
    }
  }
}

function checkSchemaSqlCoverage(schemaSql: string, tableName: string, schemaKeys: Set<string>): void {
  const excluded = new Set(["saved_config_id", "user_saved_config_id", "created_at", "updated_at"]);

  for (const key of schemaKeys) {
    if (excluded.has(key)) continue;

    if (!hasSchemaSqlColumn(schemaSql, tableName, key)) {
      addIssue("schema-sql-coverage", `${tableName}.${key} exists in Zod schema but not in schema.sql`);
    }
  }
}

function extractCreateTableNames(schemaSql: string): Set<string> {
  return new Set(
    Array.from(
      schemaSql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi),
      (match) => match[1],
    ),
  );
}

function checkRuntimeStateExportExclusions(schemaSql: string): void {
  const tableNames = extractCreateTableNames(schemaSql);
  const runtimeStateTables = Array.from(tableNames).filter((tableName) => tableName.endsWith("_runtime_state"));

  for (const tableName of runtimeStateTables) {
    if (!RUNTIME_STATE_EXPORT_EXCLUDED_TABLES.has(tableName)) {
      addIssue(
        "runtime-state-export",
        `${tableName} is a runtime-state table but is not explicitly excluded from export coverage`,
      );
    }
  }

  for (const tableName of RUNTIME_STATE_EXPORT_EXCLUDED_TABLES) {
    if (!tableNames.has(tableName)) {
      addIssue("runtime-state-export", `${tableName} is excluded from export coverage but is missing from schema.sql`);
    }
  }
}

/**
 * Soft-warning (console.warn only, no CI failure) that fires when any
 * `*_configs` table created in a migration file exceeds the 15-column
 * fission threshold.  Tables on the exemption list are structural exceptions
 * where column growth is justified by their access pattern.
 *
 * Exemptions:
 *   server_capabilities_configs: uniform boolean cluster iterated by
 *     PERMISSION_DEFINITIONS array; growth is structurally uniform.
 *   saved_provider_configs: atomic snapshot table; all columns are written
 *     together as a unit by /server save-provider.
 *   server_chat_configs: aggregate /config + /model parameter surface;
 *     each column maps to exactly one command option knob.
 */
async function checkConfigsColumnThreshold(migrationsDir: string): Promise<void> {
  const EXEMPT_TABLES = new Set(["server_capabilities_configs", "saved_provider_configs", "server_chat_configs"]);
  const COLUMN_THRESHOLD = 15;

  const files = await readdir(migrationsDir);
  const upFiles = files.filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));

  for (const file of upFiles) {
    const content = await readFile(join(migrationsDir, file), "utf-8");
    const lines = content.split("\n");

    let inTable = false;
    let currentTable = "";
    let columnCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!inTable) {
        const tableName = trimmed.match(/^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\($/i)?.[1];
        if (tableName?.endsWith("_configs")) {
          inTable = true;
          currentTable = tableName;
          columnCount = 0;
        }
        continue;
      }

      if (trimmed === ");") {
        if (!EXEMPT_TABLES.has(currentTable) && columnCount > COLUMN_THRESHOLD) {
          console.warn(
            `[check-schema] WARNING: ${currentTable} in ${file} has ${columnCount} columns ` +
              `(threshold: ${COLUMN_THRESHOLD}). Consider splitting at a command boundary ` +
              `or adding an exemption in checkSchemaDrift.ts.`,
          );
        }
        inTable = false;
        continue;
      }

      if (!trimmed || trimmed.startsWith("--")) continue;
      if (/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE\b|CHECK\s*\(|FOREIGN\s+KEY)/i.test(trimmed)) continue;

      columnCount++;
    }
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  const schemaTs = await readFile(join(root, "src", "types", "db", "schema.ts"), "utf-8");
  const dataExportTs = await readFile(join(root, "src", "types", "db", "dataExport.ts"), "utf-8");
  const dataExportImpl = await readFile(
    join(root, "src", "utils", "db", "repositories", "ExportRepository.ts"),
    "utf-8",
  );
  const dataImportImpl = await readFile(
    join(root, "src", "utils", "db", "repositories", "ImportRepository.ts"),
    "utf-8",
  );
  const repoDir = join(root, "src", "utils", "db", "repositories");
  const repoFiles = await readdir(repoDir);
  const repoContents = await Promise.all(
    repoFiles.filter((f) => f.endsWith(".ts")).map((f) => readFile(join(repoDir, f), "utf-8")),
  );
  const allRepositories = repoContents.join("\n");
  const schemaSql = await readFile(join(root, "src", "db", "schema.sql"), "utf-8");

  const savedProviderConfigKeys = extractZodObjectKeys(schemaTs, "savedProviderConfigSchema");
  const userSavedProviderConfigKeys = extractZodObjectKeys(schemaTs, "userSavedProviderConfigSchema");
  const serverConfigExportKeys = extractZodObjectKeys(dataExportTs, "serverConfigExportSchema");

  checkServerConfigExportComposition(schemaTs, dataExportTs, serverConfigExportKeys);
  checkV2ConfigProjectionCoverage(schemaTs, dataExportTs, dataExportImpl);
  checkExportImportMappings(serverConfigExportKeys, dataExportImpl, dataImportImpl);
  checkInsertCounts(allRepositories, "saved_provider_configs");
  checkInsertCounts(allRepositories, "user_saved_provider_configs");

  checkSchemaSqlCoverage(schemaSql, "saved_provider_configs", savedProviderConfigKeys);
  checkSchemaSqlCoverage(schemaSql, "user_saved_provider_configs", userSavedProviderConfigKeys);
  checkRuntimeStateExportExclusions(schemaSql);

  await checkConfigsColumnThreshold(join(root, "src", "db", "migrations"));

  if (issueList.length === 0) return;

  console.error("Schema drift check failed:");
  for (const issue of issueList) {
    console.error(`- [${issue.check}] ${issue.message}`);
  }
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
