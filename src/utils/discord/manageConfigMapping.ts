import type {
  AssembledServerConfig,
  ServerCapabilitiesConfigRow,
  ServerMemberPermissionsConfigRow,
} from "@/types/db/schema";

type BooleanColumn<T> = {
  [K in keyof T]-?: T[K] extends boolean ? K : never;
}[keyof T];

type ServerCapabilitiesBooleanColumn = BooleanColumn<ServerCapabilitiesConfigRow>;
type ServerMemberPermissionsBooleanColumn = BooleanColumn<ServerMemberPermissionsConfigRow>;

type CapabilitiesManageCapabilityColumn = Extract<
  ServerCapabilitiesBooleanColumn,
  | "emoji_usage_enabled"
  | "sticker_usage_enabled"
  | "web_search_enabled"
  | "manage_message_enabled"
  | "thread_creation_enabled"
  | "imagegen_enabled"
  | "videogen_enabled"
  | "voice_message_enabled"
  | "user_blocking_enabled"
  | "short_term_memory_enabled"
  | "user_info_updates_enabled"
  | "time_awareness_enabled"
>;

type CapabilitiesManageMemberPermissionColumn = Extract<
  ServerMemberPermissionsBooleanColumn,
  "self_teaching_enabled" | "personal_memories_enabled"
>;

export type CapabilitiesManageConfigState = Pick<
  AssembledServerConfig,
  CapabilitiesManageCapabilityColumn | CapabilitiesManageMemberPermissionColumn
>;

interface PermissionDefinitionBase {
  page: "available-tools" | "context-additions";
  /** Value used as the checkbox option identifier */
  value: string;
  /** Locale key for the option label */
  labelKey: string;
  /** Locale key for the short option description shown in the checkbox */
  descKey: string;
  /** Extracts current state from a config row */
  getState: (config: CapabilitiesManageConfigState) => boolean;
  /** If true, this option is only shown when an ElevenLabs key is configured */
  requiresElevenLabs?: boolean;
}

export type CapabilitiesManagePermissionDefinition =
  | (PermissionDefinitionBase & {
      table: "memberPermissions";
      /** The server_member_permissions_configs column to update */
      dbColumn: CapabilitiesManageMemberPermissionColumn;
    })
  | (PermissionDefinitionBase & {
      table: "capabilities";
      /** The server_capabilities_configs column to update */
      dbColumn: CapabilitiesManageCapabilityColumn;
    });

type CapabilitiesManageConfigChange =
  | {
      value: string;
      table: "memberPermissions";
      dbColumn: CapabilitiesManageMemberPermissionColumn;
      isEnabled: boolean;
      labelKey: string;
    }
  | {
      value: string;
      table: "capabilities";
      dbColumn: CapabilitiesManageCapabilityColumn;
      isEnabled: boolean;
      labelKey: string;
    };

export interface CapabilitiesManageConfigWritePlan {
  method: "updateCapabilitiesAndMemberPermissionsConfig";
  patch: {
    capabilities: Partial<ServerCapabilitiesConfigRow>;
    memberPermissions: Partial<ServerMemberPermissionsConfigRow>;
  };
  changes: CapabilitiesManageConfigChange[];
}

const CAPABILITIES_MANAGE_PERMISSION_DEFINITIONS: readonly CapabilitiesManagePermissionDefinition[] = [
  {
    value: "selfteaching",
    page: "available-tools",
    table: "memberPermissions",
    dbColumn: "self_teaching_enabled",
    labelKey: "commands.capabilities.manage.selfteaching_option",
    descKey: "commands.capabilities.manage.selfteaching_desc",
    getState: (c) => c.self_teaching_enabled,
  },
  {
    value: "userinfo",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "user_info_updates_enabled",
    labelKey: "commands.capabilities.manage.userinfo_option",
    descKey: "commands.capabilities.manage.userinfo_desc",
    getState: (c) => c.user_info_updates_enabled ?? true,
  },
  {
    value: "stickerusage",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "sticker_usage_enabled",
    labelKey: "commands.capabilities.manage.stickerusage_option",
    descKey: "commands.capabilities.manage.stickerusage_desc",
    getState: (c) => c.sticker_usage_enabled,
  },
  {
    value: "websearch",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "web_search_enabled",
    labelKey: "commands.capabilities.manage.websearch_option",
    descKey: "commands.capabilities.manage.websearch_desc",
    getState: (c) => c.web_search_enabled,
  },
  {
    value: "managemessage",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "manage_message_enabled",
    labelKey: "commands.capabilities.manage.managemessage_option",
    descKey: "commands.capabilities.manage.managemessage_desc",
    getState: (c) => c.manage_message_enabled,
  },
  {
    value: "threadcreation",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "thread_creation_enabled",
    labelKey: "commands.capabilities.manage.threadcreation_option",
    descKey: "commands.capabilities.manage.threadcreation_desc",
    getState: (c) => c.thread_creation_enabled,
  },
  {
    value: "imagegen",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "imagegen_enabled",
    labelKey: "commands.capabilities.manage.imagegen_option",
    descKey: "commands.capabilities.manage.imagegen_desc",
    getState: (c) => c.imagegen_enabled,
  },
  {
    value: "videogen",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "videogen_enabled",
    labelKey: "commands.capabilities.manage.videogen_option",
    descKey: "commands.capabilities.manage.videogen_desc",
    getState: (c) => c.videogen_enabled,
  },
  {
    value: "voicemessage",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "voice_message_enabled",
    labelKey: "commands.capabilities.manage.voicemessage_option",
    descKey: "commands.capabilities.manage.voicemessage_desc",
    getState: (c) => c.voice_message_enabled ?? true,
    requiresElevenLabs: true,
  },
  {
    value: "userblocking",
    page: "available-tools",
    table: "capabilities",
    dbColumn: "user_blocking_enabled",
    labelKey: "commands.capabilities.manage.userblocking_option",
    descKey: "commands.capabilities.manage.userblocking_desc",
    getState: (c) => c.user_blocking_enabled ?? true,
  },
  {
    value: "personalization",
    page: "context-additions",
    table: "memberPermissions",
    dbColumn: "personal_memories_enabled",
    labelKey: "commands.capabilities.manage.personalization_option",
    descKey: "commands.capabilities.manage.personalization_desc",
    getState: (c) => c.personal_memories_enabled,
  },
  {
    value: "emojiusage",
    page: "context-additions",
    table: "capabilities",
    dbColumn: "emoji_usage_enabled",
    labelKey: "commands.capabilities.manage.emojiusage_option",
    descKey: "commands.capabilities.manage.emojiusage_desc",
    getState: (c) => c.emoji_usage_enabled,
  },
  {
    value: "shorttermmemory",
    page: "context-additions",
    table: "capabilities",
    dbColumn: "short_term_memory_enabled",
    labelKey: "commands.capabilities.manage.shorttermmemory_option",
    descKey: "commands.capabilities.manage.shorttermmemory_desc",
    getState: (c) => c.short_term_memory_enabled ?? true,
  },
  {
    value: "timeawareness",
    page: "context-additions",
    table: "capabilities",
    dbColumn: "time_awareness_enabled",
    labelKey: "commands.capabilities.manage.timeawareness_option",
    descKey: "commands.capabilities.manage.timeawareness_desc",
    getState: (c) => c.time_awareness_enabled ?? true,
  },
];

export function getCapabilitiesManagePermissionDefinitions(options?: {
  includeElevenLabs?: boolean;
  page?: "available-tools" | "context-additions";
}): readonly CapabilitiesManagePermissionDefinition[] {
  const definitions = options?.page
    ? CAPABILITIES_MANAGE_PERMISSION_DEFINITIONS.filter((def) => def.page === options.page)
    : CAPABILITIES_MANAGE_PERMISSION_DEFINITIONS;
  if (options?.includeElevenLabs === false) {
    return definitions.filter((def) => !def.requiresElevenLabs);
  }
  return definitions;
}

export function buildCapabilitiesManageConfigWritePlan(
  config: CapabilitiesManageConfigState,
  selectedValues: Iterable<string>,
  options?: { includeElevenLabs?: boolean; page?: "available-tools" | "context-additions" },
): CapabilitiesManageConfigWritePlan {
  const selectedValueSet = new Set(selectedValues);
  const definitions = getCapabilitiesManagePermissionDefinitions(options);
  const changes: CapabilitiesManageConfigChange[] = [];
  const capabilities: Partial<ServerCapabilitiesConfigRow> = {};
  const memberPermissions: Partial<ServerMemberPermissionsConfigRow> = {};

  for (const def of definitions) {
    const wasEnabled = def.getState(config);
    const isEnabled = selectedValueSet.has(def.value);
    if (wasEnabled === isEnabled) continue;

    const change = {
      value: def.value,
      table: def.table,
      dbColumn: def.dbColumn,
      isEnabled,
      labelKey: def.labelKey,
    } as CapabilitiesManageConfigChange;
    changes.push(change);

    if (change.table === "memberPermissions") {
      memberPermissions[change.dbColumn] = change.isEnabled;
    } else {
      capabilities[change.dbColumn] = change.isEnabled;
    }
  }

  return {
    method: "updateCapabilitiesAndMemberPermissionsConfig",
    patch: {
      capabilities,
      memberPermissions,
    },
    changes,
  };
}
