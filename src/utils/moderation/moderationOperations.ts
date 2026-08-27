import {
  CooldownType,
  type ChannelPersonaWhitelistRow,
  type ChannelWhitelistRow,
  type ImageQuotaConfigRow,
  type PersonaUserBlockRow,
  type RoleWhitelistRow,
  type ServerMemberPermissionsConfigRow,
  type TextQuotaConfigRow,
  type TomoriState,
  type VideoQuotaConfigRow,
} from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import { invalidateWhitelistCache } from "@/utils/cache/channelWhitelistCache";
import { invalidatePersonaUserBlockCache } from "@/utils/cache/personaUserBlockCache";
import {
  getCachedAllPersonas,
  getCachedTomoriState,
  getLastDbError,
  getRecordedDbError,
  invalidateTomoriStateCache,
} from "@/utils/cache/tomoriStateCache";
import { invalidateUserBlacklistCache } from "@/utils/cache/userCache";
import {
  configRepository,
  personaUserBlockRepository,
  serverRepository,
  whitelistRepository,
} from "@/utils/db/repositories";
import {
  getImageConfigResult,
  getOrCreateImageConfig,
  getOrCreateTextConfig,
  getOrCreateVideoConfig,
  getTextConfigResult,
  getVideoConfigResult,
  updateImageDailyUserQuota,
  updateImageServerwideQuota,
  updateImageServerwideResetDays,
  updateTextDailyUserQuota,
  updateTextServerwideQuota,
  updateTextServerwideResetDays,
  updateVideoDailyUserQuota,
  updateVideoServerwideQuota,
  updateVideoServerwideResetDays,
  type ImageQuotaConfigReadResult,
  type TextQuotaConfigReadResult,
  type VideoQuotaConfigReadResult,
} from "@/utils/db/repositories/QuotaRepository";
import {
  buildServerMemberPermissionsConfigWritePlan,
  type ServerMemberPermissionsCommandConfigState,
  type ServerMemberPermissionsConfigWritePlan,
} from "@/utils/discord/memberPermissionsConfigMapping";
import type { QuotaType } from "@/utils/discord/moderationPanelCatalog";
import type { BlacklistReadResult } from "@/utils/db/repositories/ServerRepository";
import type {
  PersonaUserBlockKey,
  PersonaUserBlockReadResult,
  PersonaUserBlockWithPersona,
} from "@/utils/db/repositories/PersonaUserBlockRepository";
import type {
  WhitelistChannelsReadResult,
  WhitelistPersonasReadResult,
  WhitelistRolesReadResult,
} from "@/utils/db/repositories/WhitelistRepository";

export interface QuotaConfigState {
  daily_user_quota: number;
  serverwide_quota: number;
  serverwide_quota_resets_in: number;
}

interface ModerationQuotasData {
  image: QuotaConfigState;
  text: QuotaConfigState;
  video: QuotaConfigState;
}

export interface ModerationMemberAccessData {
  serverMemteachingEnabled: boolean;
  attributeMemteachingEnabled: boolean;
  sampledialogueMemteachingEnabled: boolean;
  promptSnapshotEnabled: boolean;
}

interface ModerationUserBlacklistData {
  personalizationUserIds: string[];
  personaBlocks: PersonaUserBlockWithPersona[];
  personalMemoriesEnabled: boolean;
}

interface ModerationWhitelistData {
  channels: ChannelWhitelistRow[];
  personaChannels: ChannelPersonaWhitelistRow[];
  roles: RoleWhitelistRow[];
  personaNames: Map<number, string>;
}

/**
 * Deliberately a sibling of `memberAccess` rather than a field inside it. The four member-access
 * checkboxes write `server_member_permissions_configs` in one submit; this writes
 * `server_byok_configs`. Folding it in would invite a single interaction that writes two tables with
 * no transaction around them.
 */
interface ModerationServerModelAccessData {
  allowServerModels: boolean;
}

export interface ModerationScopeData {
  guildId: string;
  serverId: number;
  readStatus: PanelReadStatus;
  memberAccess: ModerationMemberAccessData;
  serverModelAccess: ModerationServerModelAccessData;
  userBlacklist: ModerationUserBlacklistData;
  whitelist: ModerationWhitelistData;
  quotas: ModerationQuotasData;
}

export interface ModerationMemberAccessScopeData {
  guildId: string;
  serverId: number;
  readStatus: PanelReadStatus;
  memberAccess: ModerationMemberAccessData;
}

export interface ModerationMemberAccessDataDependencies {
  getState(guildId: string): Promise<TomoriState | null>;
  getLastDbError(guildId: string): { message: string; timestamp: number } | null;
  getRecordedDbError?(guildId: string): { message: string; timestamp: number } | null;
}

const defaultMemberAccessDependencies: ModerationMemberAccessDataDependencies = {
  getState: (guildId) => getCachedTomoriState(guildId),
  getLastDbError: (guildId) => getLastDbError(guildId),
  getRecordedDbError: (guildId) => getRecordedDbError(guildId),
};

export async function loadModerationMemberAccessData(
  guildId: string,
  deps: ModerationMemberAccessDataDependencies = defaultMemberAccessDependencies,
): Promise<ModerationMemberAccessScopeData | null> {
  const tomoriState = await deps.getState(guildId);

  if (!tomoriState) {
    const dbError = deps.getLastDbError(guildId);
    if (dbError) {
      return {
        guildId,
        serverId: 0,
        readStatus: "unavailable",
        memberAccess: {
          serverMemteachingEnabled: false,
          attributeMemteachingEnabled: false,
          sampledialogueMemteachingEnabled: false,
          promptSnapshotEnabled: false,
        },
      };
    }
    return null;
  }

  const dbError = (deps.getRecordedDbError ?? deps.getLastDbError)(guildId);
  return {
    guildId,
    serverId: tomoriState.server_id,
    readStatus: dbError ? "stale" : "fresh",
    memberAccess: {
      serverMemteachingEnabled: Boolean(tomoriState.config.server_memteaching_enabled),
      attributeMemteachingEnabled: Boolean(tomoriState.config.attribute_memteaching_enabled),
      sampledialogueMemteachingEnabled: Boolean(tomoriState.config.sampledialogue_memteaching_enabled),
      promptSnapshotEnabled: Boolean(tomoriState.config.prompt_snapshot_enabled),
    },
  };
}

export interface ModerationUserBlacklistAddScopeData {
  guildId: string;
  serverId: number;
  readStatus: PanelReadStatus;
  personalMemoriesEnabled: boolean;
}

export interface ModerationUserBlacklistAddDataDependencies {
  getState(guildId: string): Promise<TomoriState | null>;
  getLastDbError(guildId: string): { message: string; timestamp: number } | null;
  getRecordedDbError?(guildId: string): { message: string; timestamp: number } | null;
}

const defaultUserBlacklistAddScopeDependencies: ModerationUserBlacklistAddDataDependencies = {
  getState: (guildId) => getCachedTomoriState(guildId),
  getLastDbError: (guildId) => getLastDbError(guildId),
  getRecordedDbError: (guildId) => getRecordedDbError(guildId),
};

export async function loadModerationUserBlacklistAddData(
  guildId: string,
  deps: ModerationUserBlacklistAddDataDependencies = defaultUserBlacklistAddScopeDependencies,
): Promise<ModerationUserBlacklistAddScopeData | null> {
  const tomoriState = await deps.getState(guildId);

  if (!tomoriState) {
    const dbError = deps.getLastDbError(guildId);
    if (dbError) {
      return {
        guildId,
        serverId: 0,
        readStatus: "unavailable",
        personalMemoriesEnabled: false,
      };
    }
    return null;
  }

  const dbError = (deps.getRecordedDbError ?? deps.getLastDbError)(guildId);
  return {
    guildId,
    serverId: tomoriState.server_id,
    readStatus: dbError ? "stale" : "fresh",
    personalMemoriesEnabled: Boolean(tomoriState.config.personal_memories_enabled),
  };
}

export interface ModerationWhitelistChannelAddScopeData {
  guildId: string;
  serverId: number;
  readStatus: PanelReadStatus;
  config: {
    cooldown_type: CooldownType | null;
    cooldown_length: number | null;
  };
}

export interface ModerationWhitelistChannelAddDataDependencies {
  getState(guildId: string): Promise<TomoriState | null>;
  getLastDbError(guildId: string): { message: string; timestamp: number } | null;
  getRecordedDbError?(guildId: string): { message: string; timestamp: number } | null;
}

const defaultWhitelistChannelAddScopeDependencies: ModerationWhitelistChannelAddDataDependencies = {
  getState: (guildId) => getCachedTomoriState(guildId),
  getLastDbError: (guildId) => getLastDbError(guildId),
  getRecordedDbError: (guildId) => getRecordedDbError(guildId),
};

export async function loadModerationWhitelistChannelAddData(
  guildId: string,
  deps: ModerationWhitelistChannelAddDataDependencies = defaultWhitelistChannelAddScopeDependencies,
): Promise<ModerationWhitelistChannelAddScopeData | null> {
  const tomoriState = await deps.getState(guildId);

  if (!tomoriState) {
    const dbError = deps.getLastDbError(guildId);
    if (dbError) {
      return {
        guildId,
        serverId: 0,
        readStatus: "unavailable",
        config: {
          cooldown_type: null,
          cooldown_length: null,
        },
      };
    }
    return null;
  }

  const dbError = (deps.getRecordedDbError ?? deps.getLastDbError)(guildId);
  return {
    guildId,
    serverId: tomoriState.server_id,
    readStatus: dbError ? "stale" : "fresh",
    config: {
      cooldown_type: (tomoriState.config.cooldown_type as CooldownType | undefined) ?? null,
      cooldown_length: tomoriState.config.cooldown_length ?? null,
    },
  };
}

export interface ModerationDataDependencies {
  refresh?(guildId: string): void | Promise<void>;
  getState(guildId: string): Promise<TomoriState | null>;
  getAllPersonas(guildId: string): Promise<TomoriState[]>;
  getLastDbError(guildId: string): { message: string; timestamp: number } | null;
  getRecordedDbError?(guildId: string): { message: string; timestamp: number } | null;
  getBlacklist(serverId: number): Promise<BlacklistReadResult>;
  getPersonaBlocks(serverId: number): Promise<PersonaUserBlockReadResult>;
  getWhitelistChannels(serverId: number): Promise<WhitelistChannelsReadResult>;
  getWhitelistPersonas(serverId: number): Promise<WhitelistPersonasReadResult>;
  getWhitelistRoles(serverId: number): Promise<WhitelistRolesReadResult>;
  getTextQuotaConfig(serverId: number): Promise<TextQuotaConfigReadResult>;
  getImageQuotaConfig(serverId: number): Promise<ImageQuotaConfigReadResult>;
  getVideoQuotaConfig(serverId: number): Promise<VideoQuotaConfigReadResult>;
}

const defaultDependencies: ModerationDataDependencies = {
  refresh: (guildId) => invalidateTomoriStateCache(guildId),
  getState: (guildId) => getCachedTomoriState(guildId),
  getAllPersonas: (guildId) => getCachedAllPersonas(guildId),
  getLastDbError: (guildId) => getLastDbError(guildId),
  getRecordedDbError: (guildId) => getRecordedDbError(guildId),
  getBlacklist: (serverId) => serverRepository.getBlacklistedMemberIdsResult(serverId),
  getPersonaBlocks: (serverId) => personaUserBlockRepository.loadActiveBlocksForServerResult(serverId),
  getWhitelistChannels: (serverId) => whitelistRepository.getAllWhitelistChannelsResult(serverId),
  getWhitelistPersonas: (serverId) => whitelistRepository.getAllWhitelistPersonasResult(serverId),
  getWhitelistRoles: (serverId) => whitelistRepository.getAllWhitelistRolesResult(serverId),
  getTextQuotaConfig: (serverId) => getTextConfigResult(serverId),
  getImageQuotaConfig: (serverId) => getImageConfigResult(serverId),
  getVideoQuotaConfig: (serverId) => getVideoConfigResult(serverId),
};

export async function loadModerationScopeData(
  guildId: string,
  forceRefresh = false,
  deps: ModerationDataDependencies = defaultDependencies,
): Promise<ModerationScopeData | null> {
  if (forceRefresh) {
    await deps.refresh?.(guildId);
  }

  const tomoriState = await deps.getState(guildId);

  if (!tomoriState) {
    const dbError = deps.getLastDbError(guildId);
    if (dbError) {
      return {
        guildId,
        serverId: 0,
        readStatus: "unavailable",
        memberAccess: {
          serverMemteachingEnabled: false,
          attributeMemteachingEnabled: false,
          sampledialogueMemteachingEnabled: false,
          promptSnapshotEnabled: false,
        },
        serverModelAccess: { allowServerModels: true },
        userBlacklist: {
          personalizationUserIds: [],
          personaBlocks: [],
          personalMemoriesEnabled: false,
        },
        whitelist: {
          channels: [],
          personaChannels: [],
          roles: [],
          personaNames: new Map(),
        },
        quotas: {
          image: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
          text: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
          video: { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 },
        },
      };
    }
    return null;
  }

  const serverId = tomoriState.server_id;

  const [
    allPersonas,
    blacklistResult,
    personaBlocksResult,
    channelsResult,
    personaChannelsResult,
    rolesResult,
    textQuotaResult,
    imageQuotaResult,
    videoQuotaResult,
  ] = await Promise.all([
    deps.getAllPersonas(guildId),
    deps.getBlacklist(serverId),
    deps.getPersonaBlocks(serverId),
    deps.getWhitelistChannels(serverId),
    deps.getWhitelistPersonas(serverId),
    deps.getWhitelistRoles(serverId),
    deps.getTextQuotaConfig(serverId),
    deps.getImageQuotaConfig(serverId),
    deps.getVideoQuotaConfig(serverId),
  ]);

  const dbError = (deps.getRecordedDbError ?? deps.getLastDbError)(guildId);

  const hasUnavailableRead =
    blacklistResult.status === "unavailable" ||
    personaBlocksResult.status === "unavailable" ||
    channelsResult.status === "unavailable" ||
    personaChannelsResult.status === "unavailable" ||
    rolesResult.status === "unavailable" ||
    textQuotaResult.status === "unavailable" ||
    imageQuotaResult.status === "unavailable" ||
    videoQuotaResult.status === "unavailable";

  let readStatus: PanelReadStatus = "fresh";
  if (hasUnavailableRead) {
    readStatus = "unavailable";
  } else if (dbError) {
    readStatus = "stale";
  }

  const personaNames = new Map<number, string>();
  for (const persona of allPersonas) {
    if (typeof persona.persona_id === "number") {
      personaNames.set(persona.persona_id, persona.persona_nickname);
    }
  }

  const imageQuota: QuotaConfigState = imageQuotaResult.config
    ? {
        daily_user_quota: imageQuotaResult.config.daily_user_quota,
        serverwide_quota: imageQuotaResult.config.serverwide_quota,
        serverwide_quota_resets_in: imageQuotaResult.config.serverwide_quota_resets_in,
      }
    : { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 };

  const textQuota: QuotaConfigState = textQuotaResult.config
    ? {
        daily_user_quota: textQuotaResult.config.daily_user_quota,
        serverwide_quota: textQuotaResult.config.serverwide_quota,
        serverwide_quota_resets_in: textQuotaResult.config.serverwide_quota_resets_in,
      }
    : { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 };

  const videoQuota: QuotaConfigState = videoQuotaResult.config
    ? {
        daily_user_quota: videoQuotaResult.config.daily_user_quota,
        serverwide_quota: videoQuotaResult.config.serverwide_quota,
        serverwide_quota_resets_in: videoQuotaResult.config.serverwide_quota_resets_in,
      }
    : { daily_user_quota: 0, serverwide_quota: 0, serverwide_quota_resets_in: 365 };

  return {
    guildId,
    serverId,
    readStatus,
    memberAccess: {
      serverMemteachingEnabled: Boolean(tomoriState.config.server_memteaching_enabled),
      attributeMemteachingEnabled: Boolean(tomoriState.config.attribute_memteaching_enabled),
      sampledialogueMemteachingEnabled: Boolean(tomoriState.config.sampledialogue_memteaching_enabled),
      promptSnapshotEnabled: Boolean(tomoriState.config.prompt_snapshot_enabled),
    },
    // The column is negative (`user_byok_mode` true means members must bring their own provider);
    // the panel states the permissive side, so it is inverted exactly here and nowhere else.
    serverModelAccess: { allowServerModels: !tomoriState.config.user_byok_mode },
    userBlacklist: {
      personalizationUserIds: blacklistResult.memberIds,
      personaBlocks: personaBlocksResult.blocks,
      personalMemoriesEnabled: Boolean(tomoriState.config.personal_memories_enabled),
    },
    whitelist: {
      channels: channelsResult.channels,
      personaChannels: personaChannelsResult.personas,
      roles: rolesResult.roles,
      personaNames,
    },
    quotas: {
      image: imageQuota,
      text: textQuota,
      video: videoQuota,
    },
  };
}

export interface UpdateMemberPermissionsInput {
  guildId: string;
  serverId: number;
  currentState: ServerMemberPermissionsCommandConfigState | ModerationMemberAccessData;
  selectedValues: Iterable<string>;
}

export type UpdateMemberPermissionsResult =
  | {
      status: "unchanged";
      changes: [];
      patch: Record<string, never>;
    }
  | {
      status: "success";
      changes: ServerMemberPermissionsConfigWritePlan["changes"];
      patch: Partial<ServerMemberPermissionsConfigRow>;
    }
  | {
      status: "failure";
      changes: ServerMemberPermissionsConfigWritePlan["changes"];
      patch: Partial<ServerMemberPermissionsConfigRow>;
    };

export interface MemberPermissionsOperationsDependencies {
  updateConfig(serverId: number, patch: Partial<ServerMemberPermissionsConfigRow>): Promise<boolean>;
  invalidateCache(guildId: string): void;
}

const defaultMemberPermissionsDependencies: MemberPermissionsOperationsDependencies = {
  updateConfig: (serverId, patch) => configRepository.updateMemberPermissionsConfig(serverId, patch),
  invalidateCache: (guildId) => invalidateTomoriStateCache(guildId),
};

function normalizeMemberAccessState(
  state: ServerMemberPermissionsCommandConfigState | ModerationMemberAccessData,
): ServerMemberPermissionsCommandConfigState {
  if ("server_memteaching_enabled" in state) {
    return state;
  }
  return {
    server_memteaching_enabled: state.serverMemteachingEnabled,
    attribute_memteaching_enabled: state.attributeMemteachingEnabled,
    sampledialogue_memteaching_enabled: state.sampledialogueMemteachingEnabled,
    prompt_snapshot_enabled: state.promptSnapshotEnabled,
  };
}

export async function updateMemberPermissions(
  input: UpdateMemberPermissionsInput,
  deps: MemberPermissionsOperationsDependencies = defaultMemberPermissionsDependencies,
): Promise<UpdateMemberPermissionsResult> {
  const normalizedState = normalizeMemberAccessState(input.currentState);
  const writePlan = buildServerMemberPermissionsConfigWritePlan(normalizedState, input.selectedValues);

  if (writePlan.changes.length === 0) {
    return {
      status: "unchanged",
      changes: [],
      patch: {},
    };
  }

  const updated = await deps.updateConfig(input.serverId, writePlan.patch);
  if (!updated) {
    return {
      status: "failure",
      changes: writePlan.changes,
      patch: writePlan.patch,
    };
  }

  deps.invalidateCache(input.guildId);

  return {
    status: "success",
    changes: writePlan.changes,
    patch: writePlan.patch,
  };
}

export interface UpdateServerModelAccessInput {
  guildId: string;
  serverId: number;
  currentAllowServerModels: boolean;
  allowServerModels: boolean;
}

export type UpdateServerModelAccessResult = { status: "success" | "unchanged" | "failure"; allowServerModels: boolean };

export interface ServerModelAccessOperationsDependencies {
  updateByokConfig(serverId: number, patch: { user_byok_mode: boolean }): Promise<boolean>;
  invalidateCache(guildId: string): void;
}

const defaultServerModelAccessDependencies: ServerModelAccessOperationsDependencies = {
  updateByokConfig: (serverId, patch) => configRepository.updateByokConfig(serverId, patch),
  invalidateCache: (guildId) => invalidateTomoriStateCache(guildId),
};

export async function updateServerModelAccess(
  input: UpdateServerModelAccessInput,
  deps: ServerModelAccessOperationsDependencies = defaultServerModelAccessDependencies,
): Promise<UpdateServerModelAccessResult> {
  if (input.currentAllowServerModels === input.allowServerModels) {
    return { status: "unchanged", allowServerModels: input.allowServerModels };
  }

  const updated = await deps.updateByokConfig(input.serverId, { user_byok_mode: !input.allowServerModels });
  if (!updated) {
    return { status: "failure", allowServerModels: input.currentAllowServerModels };
  }

  deps.invalidateCache(input.guildId);
  return { status: "success", allowServerModels: input.allowServerModels };
}

export interface AddUserToBlacklistInput {
  guildId: string;
  serverId: number;
  targetUserId: string;
  isBot?: boolean;
  personalMemoriesEnabled?: boolean;
}

export type AddUserToBlacklistResult =
  | { status: "success"; targetUserId: string }
  | { status: "already_blacklisted"; targetUserId: string }
  | { status: "bot"; targetUserId: string }
  | { status: "personalization_disabled"; targetUserId: string }
  | { status: "failure"; targetUserId: string };

export interface UserBlacklistOperationsDependencies {
  isUserBlacklisted(serverId: number, targetUserId: string): Promise<boolean>;
  addUserBlacklist(serverId: number, targetUserId: string): Promise<boolean>;
  invalidateCache(guildId: string, targetUserId: string): void;
}

const defaultUserBlacklistOperationsDependencies: UserBlacklistOperationsDependencies = {
  isUserBlacklisted: (serverId, targetUserId) => serverRepository.isUserBlacklisted(serverId, targetUserId),
  addUserBlacklist: (serverId, targetUserId) => serverRepository.addUserBlacklist(serverId, targetUserId),
  invalidateCache: (guildId, targetUserId) => invalidateUserBlacklistCache(guildId, targetUserId),
};

export async function addUserToBlacklist(
  input: AddUserToBlacklistInput,
  deps: UserBlacklistOperationsDependencies = defaultUserBlacklistOperationsDependencies,
): Promise<AddUserToBlacklistResult> {
  if (input.isBot) {
    return {
      status: "bot",
      targetUserId: input.targetUserId,
    };
  }

  if (input.personalMemoriesEnabled === false) {
    return {
      status: "personalization_disabled",
      targetUserId: input.targetUserId,
    };
  }

  const isAlreadyBlacklisted = await deps.isUserBlacklisted(input.serverId, input.targetUserId);
  if (isAlreadyBlacklisted) {
    return {
      status: "already_blacklisted",
      targetUserId: input.targetUserId,
    };
  }

  const added = await deps.addUserBlacklist(input.serverId, input.targetUserId);
  if (!added) {
    return {
      status: "failure",
      targetUserId: input.targetUserId,
    };
  }

  deps.invalidateCache(input.guildId, input.targetUserId);

  return {
    status: "success",
    targetUserId: input.targetUserId,
  };
}

export interface RemoveUserFromBlacklistInput {
  guildId: string;
  serverId: number;
  targetUserId: string;
}

export type RemoveUserFromBlacklistResult =
  | { status: "success"; targetUserId: string }
  | { status: "not_found"; targetUserId: string }
  | { status: "failure"; targetUserId: string };

export interface RemoveUserBlacklistOperationsDependencies {
  removePersonalizationMany(serverId: number, userIds: string[]): Promise<number>;
  invalidateCache(guildId: string, targetUserId: string): void;
}

const defaultRemoveUserBlacklistDependencies: RemoveUserBlacklistOperationsDependencies = {
  removePersonalizationMany: (serverId, userIds) => serverRepository.removeUserBlacklistMany(serverId, userIds),
  invalidateCache: (guildId, targetUserId) => invalidateUserBlacklistCache(guildId, targetUserId),
};

export async function removeUserFromBlacklist(
  input: RemoveUserFromBlacklistInput,
  deps: RemoveUserBlacklistOperationsDependencies = defaultRemoveUserBlacklistDependencies,
): Promise<RemoveUserFromBlacklistResult> {
  try {
    const deletedCount = await deps.removePersonalizationMany(input.serverId, [input.targetUserId]);
    if (deletedCount > 0) {
      deps.invalidateCache(input.guildId, input.targetUserId);
      return {
        status: "success",
        targetUserId: input.targetUserId,
      };
    }
    return {
      status: "not_found",
      targetUserId: input.targetUserId,
    };
  } catch {
    return {
      status: "failure",
      targetUserId: input.targetUserId,
    };
  }
}

export interface RemovePersonaUserBlockInput {
  guildId: string;
  serverId: number;
  personaId: number;
  targetUserId: string;
}

export type RemovePersonaUserBlockResult =
  | { status: "success"; personaId: number; targetUserId: string; block: PersonaUserBlockRow }
  | { status: "not_found"; personaId: number; targetUserId: string }
  | { status: "failure"; personaId: number; targetUserId: string };

export interface RemovePersonaUserBlockOperationsDependencies {
  removeBlocksByKeys(serverId: number, keys: PersonaUserBlockKey[]): Promise<PersonaUserBlockRow[]>;
  invalidateCache(serverId: number, personaId: number, targetUserId: string): void;
}

const defaultRemovePersonaUserBlockDependencies: RemovePersonaUserBlockOperationsDependencies = {
  removeBlocksByKeys: (serverId, keys) => personaUserBlockRepository.removeBlocksByKeys(serverId, keys),
  invalidateCache: (serverId, personaId, targetUserId) =>
    invalidatePersonaUserBlockCache(serverId, personaId, targetUserId),
};

export async function removePersonaUserBlock(
  input: RemovePersonaUserBlockInput,
  deps: RemovePersonaUserBlockOperationsDependencies = defaultRemovePersonaUserBlockDependencies,
): Promise<RemovePersonaUserBlockResult> {
  try {
    const removedRows = await deps.removeBlocksByKeys(input.serverId, [
      { personaId: input.personaId, userDiscId: input.targetUserId },
    ]);
    if (removedRows.length > 0 && removedRows[0]) {
      deps.invalidateCache(input.serverId, input.personaId, input.targetUserId);
      return {
        status: "success",
        personaId: input.personaId,
        targetUserId: input.targetUserId,
        block: removedRows[0],
      };
    }
    return {
      status: "not_found",
      personaId: input.personaId,
      targetUserId: input.targetUserId,
    };
  } catch {
    return {
      status: "failure",
      personaId: input.personaId,
      targetUserId: input.targetUserId,
    };
  }
}

export interface RemoveUserBlacklistBatchInput {
  guildId: string;
  serverId: number;
  personalizationUserIds: string[];
  personaBlockKeys: PersonaUserBlockKey[];
}

export interface RemoveUserBlacklistBatchResult {
  status: "success" | "failure";
  removedPersonalizationCount: number;
  removedPersonaBlocks: PersonaUserBlockRow[];
}

export interface RemoveUserBlacklistBatchOperationsDependencies {
  removePersonalizationMany(serverId: number, userIds: string[]): Promise<number>;
  removeBlocksByKeys(serverId: number, keys: PersonaUserBlockKey[]): Promise<PersonaUserBlockRow[]>;
  invalidatePersonalizationCache(guildId: string, userId: string): void;
  invalidatePersonaBlockCache(serverId: number, personaId: number, userId: string): void;
}

const defaultRemoveUserBlacklistBatchDependencies: RemoveUserBlacklistBatchOperationsDependencies = {
  removePersonalizationMany: (serverId, userIds) => serverRepository.removeUserBlacklistMany(serverId, userIds),
  removeBlocksByKeys: (serverId, keys) => personaUserBlockRepository.removeBlocksByKeys(serverId, keys),
  invalidatePersonalizationCache: (guildId, userId) => invalidateUserBlacklistCache(guildId, userId),
  invalidatePersonaBlockCache: (serverId, personaId, userId) =>
    invalidatePersonaUserBlockCache(serverId, personaId, userId),
};

export async function removeUserBlacklistBatch(
  input: RemoveUserBlacklistBatchInput,
  deps: RemoveUserBlacklistBatchOperationsDependencies = defaultRemoveUserBlacklistBatchDependencies,
): Promise<RemoveUserBlacklistBatchResult> {
  try {
    let removedPersonalizationCount = 0;
    if (input.personalizationUserIds.length > 0) {
      removedPersonalizationCount = await deps.removePersonalizationMany(input.serverId, input.personalizationUserIds);
      if (removedPersonalizationCount > 0) {
        for (const userId of input.personalizationUserIds) {
          deps.invalidatePersonalizationCache(input.guildId, userId);
        }
      }
    }

    let removedPersonaBlocks: PersonaUserBlockRow[] = [];
    if (input.personaBlockKeys.length > 0) {
      removedPersonaBlocks = await deps.removeBlocksByKeys(input.serverId, input.personaBlockKeys);
      for (const row of removedPersonaBlocks) {
        deps.invalidatePersonaBlockCache(input.serverId, row.persona_id, row.user_disc_id);
      }
    }

    return {
      status: "success",
      removedPersonalizationCount,
      removedPersonaBlocks,
    };
  } catch {
    return {
      status: "failure",
      removedPersonalizationCount: 0,
      removedPersonaBlocks: [],
    };
  }
}

export interface UpsertWhitelistChannelInput {
  guildId: string;
  serverId: number;
  channelId: string;
  requestedCooldownType?: CooldownType | null;
  requestedCooldownLength?: number | null;
  serverConfig?: {
    cooldown_type?: CooldownType | null;
    cooldown_length?: number | null;
  };
}

export type UpsertWhitelistChannelResult =
  | {
      status: "success";
      channelId: string;
      cooldownType: CooldownType | null;
      cooldownLength: number | null;
      isUpdate: boolean;
    }
  | {
      status: "unchanged";
      channelId: string;
      cooldownType: CooldownType | null;
      cooldownLength: number | null;
    }
  | {
      status: "failure";
      channelId: string;
    };

export interface WhitelistChannelOperationsDependencies {
  getChannelWhitelist(serverId: number, channelId: string): Promise<ChannelWhitelistRow | null>;
  upsertChannelWhitelist(
    serverId: number,
    channelId: string,
    cooldownType: CooldownType | null,
    cooldownLength: number | null,
  ): Promise<ChannelWhitelistRow>;
  invalidateCache(guildId: string): void;
}

const defaultWhitelistChannelOperationsDependencies: WhitelistChannelOperationsDependencies = {
  getChannelWhitelist: (serverId, channelId) => whitelistRepository.getChannelWhitelist(serverId, channelId),
  upsertChannelWhitelist: (serverId, channelId, cooldownType, cooldownLength) =>
    whitelistRepository.upsertChannelWhitelist(serverId, channelId, cooldownType, cooldownLength),
  invalidateCache: (guildId) => invalidateWhitelistCache(guildId),
};

export async function upsertWhitelistChannel(
  input: UpsertWhitelistChannelInput,
  deps: WhitelistChannelOperationsDependencies = defaultWhitelistChannelOperationsDependencies,
): Promise<UpsertWhitelistChannelResult> {
  try {
    const existingEntry = await deps.getChannelWhitelist(input.serverId, input.channelId);

    const hasOverrideInput =
      (input.requestedCooldownType !== undefined && input.requestedCooldownType !== null) ||
      (input.requestedCooldownLength !== undefined && input.requestedCooldownLength !== null);

    const currentCooldownType =
      existingEntry?.cooldown_type !== null &&
      existingEntry?.cooldown_type !== undefined &&
      existingEntry?.cooldown_length !== null &&
      existingEntry?.cooldown_length !== undefined
        ? (existingEntry.cooldown_type as CooldownType)
        : null;
    const currentCooldownLength =
      existingEntry?.cooldown_type !== null &&
      existingEntry?.cooldown_type !== undefined &&
      existingEntry?.cooldown_length !== null &&
      existingEntry?.cooldown_length !== undefined
        ? existingEntry.cooldown_length
        : null;

    const plannedCooldownType = hasOverrideInput
      ? ((input.requestedCooldownType ??
          currentCooldownType ??
          input.serverConfig?.cooldown_type ??
          CooldownType.OFF) as CooldownType)
      : null;
    const plannedCooldownLength = hasOverrideInput
      ? (input.requestedCooldownLength ?? currentCooldownLength ?? input.serverConfig?.cooldown_length ?? 5)
      : null;

    const storedCooldownType =
      existingEntry?.cooldown_type !== null && existingEntry?.cooldown_type !== undefined
        ? (existingEntry.cooldown_type as CooldownType)
        : null;
    const storedCooldownLength =
      existingEntry?.cooldown_length !== null && existingEntry?.cooldown_length !== undefined
        ? existingEntry.cooldown_length
        : null;

    if (existingEntry && storedCooldownType === plannedCooldownType && storedCooldownLength === plannedCooldownLength) {
      return {
        status: "unchanged",
        channelId: input.channelId,
        cooldownType: plannedCooldownType,
        cooldownLength: plannedCooldownLength,
      };
    }

    const row = await deps.upsertChannelWhitelist(
      input.serverId,
      input.channelId,
      plannedCooldownType,
      plannedCooldownLength,
    );

    if (!row) {
      return {
        status: "failure",
        channelId: input.channelId,
      };
    }

    deps.invalidateCache(input.guildId);

    return {
      status: "success",
      channelId: input.channelId,
      cooldownType: plannedCooldownType,
      cooldownLength: plannedCooldownLength,
      isUpdate: Boolean(existingEntry),
    };
  } catch {
    return {
      status: "failure",
      channelId: input.channelId,
    };
  }
}

export interface RemoveWhitelistChannelInput {
  guildId: string;
  serverId: number;
  channelId: string;
}

export type RemoveWhitelistChannelResult =
  | { status: "success"; channelId: string }
  | { status: "not_found"; channelId: string }
  | { status: "failure"; channelId: string };

export interface RemoveWhitelistChannelOperationsDependencies {
  removeChannelWhitelist(serverId: number, channelId: string): Promise<boolean>;
  invalidateCache(guildId: string): void;
}

const defaultRemoveWhitelistChannelDependencies: RemoveWhitelistChannelOperationsDependencies = {
  removeChannelWhitelist: (serverId, channelId) => whitelistRepository.removeChannelWhitelist(serverId, channelId),
  invalidateCache: (guildId) => invalidateWhitelistCache(guildId),
};

export async function removeWhitelistChannel(
  input: RemoveWhitelistChannelInput,
  deps: RemoveWhitelistChannelOperationsDependencies = defaultRemoveWhitelistChannelDependencies,
): Promise<RemoveWhitelistChannelResult> {
  try {
    const deleted = await deps.removeChannelWhitelist(input.serverId, input.channelId);
    if (deleted) {
      deps.invalidateCache(input.guildId);
      return {
        status: "success",
        channelId: input.channelId,
      };
    }
    return {
      status: "not_found",
      channelId: input.channelId,
    };
  } catch {
    return {
      status: "failure",
      channelId: input.channelId,
    };
  }
}

export interface AddWhitelistRoleInput {
  guildId: string;
  serverId: number;
  roleId: string;
}

export type AddWhitelistRoleResult =
  | { status: "success"; roleId: string }
  | { status: "unchanged"; roleId: string }
  | { status: "failure"; roleId: string };

export interface AddWhitelistRoleOperationsDependencies {
  isRoleWhitelisted(serverId: number, roleId: string): Promise<boolean>;
  upsertRoleWhitelist(serverId: number, roleId: string): Promise<RoleWhitelistRow>;
  invalidateCache(guildId: string): void;
}

const defaultAddWhitelistRoleDependencies: AddWhitelistRoleOperationsDependencies = {
  isRoleWhitelisted: (serverId, roleId) => whitelistRepository.isRoleWhitelisted(serverId, roleId),
  upsertRoleWhitelist: (serverId, roleId) => whitelistRepository.upsertRoleWhitelist(serverId, roleId),
  invalidateCache: (guildId) => invalidateWhitelistCache(guildId),
};

export async function addWhitelistRole(
  input: AddWhitelistRoleInput,
  deps: AddWhitelistRoleOperationsDependencies = defaultAddWhitelistRoleDependencies,
): Promise<AddWhitelistRoleResult> {
  try {
    if (await deps.isRoleWhitelisted(input.serverId, input.roleId)) {
      return { status: "unchanged", roleId: input.roleId };
    }

    const row = await deps.upsertRoleWhitelist(input.serverId, input.roleId);
    if (!row) return { status: "failure", roleId: input.roleId };

    deps.invalidateCache(input.guildId);
    return { status: "success", roleId: input.roleId };
  } catch {
    return { status: "failure", roleId: input.roleId };
  }
}

export interface RemoveWhitelistRoleOperationsDependencies {
  removeRoleWhitelist(serverId: number, roleId: string): Promise<boolean>;
  invalidateCache(guildId: string): void;
}

export type RemoveWhitelistRoleResult =
  | { status: "success"; roleId: string }
  | { status: "not_found"; roleId: string }
  | { status: "failure"; roleId: string };

const defaultRemoveWhitelistRoleDependencies: RemoveWhitelistRoleOperationsDependencies = {
  removeRoleWhitelist: (serverId, roleId) => whitelistRepository.removeRoleWhitelist(serverId, roleId),
  invalidateCache: (guildId) => invalidateWhitelistCache(guildId),
};

export async function removeWhitelistRole(
  input: AddWhitelistRoleInput,
  deps: RemoveWhitelistRoleOperationsDependencies = defaultRemoveWhitelistRoleDependencies,
): Promise<RemoveWhitelistRoleResult> {
  try {
    const removed = await deps.removeRoleWhitelist(input.serverId, input.roleId);
    if (!removed) return { status: "not_found", roleId: input.roleId };

    deps.invalidateCache(input.guildId);
    return { status: "success", roleId: input.roleId };
  } catch {
    return { status: "failure", roleId: input.roleId };
  }
}

export interface ReplacePersonaChannelWhitelistInput {
  guildId: string;
  serverId: number;
  personaId: number;
  selectedChannelIds: ReadonlySet<string>;
  availableChannelIds: readonly string[];
}

export type ReplacePersonaChannelWhitelistResult =
  | { status: "success"; channelIds: string[] }
  | { status: "unchanged"; channelIds: string[] }
  | { status: "failure" };

export interface ReplacePersonaChannelWhitelistDependencies {
  getPersonaWhitelistChannels(serverId: number, personaId: number): Promise<ChannelPersonaWhitelistRow[]>;
  replacePersonaWhitelistChannels(serverId: number, personaId: number, channelIds: string[]): Promise<void>;
  invalidateCache(guildId: string): void;
}

const defaultReplacePersonaChannelWhitelistDependencies: ReplacePersonaChannelWhitelistDependencies = {
  getPersonaWhitelistChannels: (serverId, personaId) =>
    whitelistRepository.getPersonaWhitelistChannels(serverId, personaId),
  replacePersonaWhitelistChannels: (serverId, personaId, channelIds) =>
    whitelistRepository.replacePersonaWhitelistChannels(serverId, personaId, channelIds),
  invalidateCache: (guildId) => invalidateWhitelistCache(guildId),
};

export async function replacePersonaChannelWhitelist(
  input: ReplacePersonaChannelWhitelistInput,
  deps: ReplacePersonaChannelWhitelistDependencies = defaultReplacePersonaChannelWhitelistDependencies,
): Promise<ReplacePersonaChannelWhitelistResult> {
  try {
    const currentRows = await deps.getPersonaWhitelistChannels(input.serverId, input.personaId);
    const normalizedChannelIds = [...new Set(input.availableChannelIds)].filter((channelId) =>
      input.selectedChannelIds.has(channelId),
    );
    const currentIds = new Set(currentRows.map((row) => row.channel_disc_id));
    const unchanged =
      currentIds.size === normalizedChannelIds.length && normalizedChannelIds.every((id) => currentIds.has(id));
    if (unchanged) return { status: "unchanged", channelIds: normalizedChannelIds };

    await deps.replacePersonaWhitelistChannels(input.serverId, input.personaId, normalizedChannelIds);
    deps.invalidateCache(input.guildId);
    return { status: "success", channelIds: normalizedChannelIds };
  } catch {
    return { status: "failure" };
  }
}

export interface UpdateQuotaSettingsInput {
  serverId: number;
  quotaType: QuotaType;
  dailyUserQuota?: number | null;
  serverwideQuota?: number | null;
  serverwideQuotaResetsIn?: number | null;
}

export type UpdateQuotaSettingsResult =
  | {
      status: "success";
      quotaType: QuotaType;
      appliedFields: Array<"daily_user_quota" | "serverwide_quota" | "serverwide_quota_resets_in">;
    }
  | {
      status: "invalid";
      quotaType: QuotaType;
      reason: string;
    }
  | {
      status: "failed";
      quotaType: QuotaType;
      error?: unknown;
    };

export interface QuotaOperationsDependencies {
  getImageConfig(serverId: number): Promise<ImageQuotaConfigRow>;
  updateImageDailyUserQuota(serverId: number, limit: number): Promise<void>;
  updateImageServerwideQuota(
    serverId: number,
    limit: number,
    currentResetDays: number,
    previousLimit: number,
  ): Promise<void>;
  updateImageServerwideResetDays(serverId: number, days: number, serverwideActive: boolean): Promise<void>;

  getTextConfig(serverId: number): Promise<TextQuotaConfigRow>;
  updateTextDailyUserQuota(serverId: number, limit: number): Promise<void>;
  updateTextServerwideQuota(
    serverId: number,
    limit: number,
    currentResetDays: number,
    previousLimit: number,
  ): Promise<void>;
  updateTextServerwideResetDays(serverId: number, days: number, serverwideActive: boolean): Promise<void>;

  getVideoConfig(serverId: number): Promise<VideoQuotaConfigRow>;
  updateVideoDailyUserQuota(serverId: number, limit: number): Promise<void>;
  updateVideoServerwideQuota(
    serverId: number,
    limit: number,
    currentResetDays: number,
    previousLimit: number,
  ): Promise<void>;
  updateVideoServerwideResetDays(serverId: number, days: number, serverwideActive: boolean): Promise<void>;
}

const defaultQuotaOperationsDependencies: QuotaOperationsDependencies = {
  getImageConfig: (serverId) => getOrCreateImageConfig(serverId),
  updateImageDailyUserQuota: (serverId, limit) => updateImageDailyUserQuota(serverId, limit),
  updateImageServerwideQuota: (serverId, limit, currentResetDays, previousLimit) =>
    updateImageServerwideQuota(serverId, limit, currentResetDays, previousLimit),
  updateImageServerwideResetDays: (serverId, days, serverwideActive) =>
    updateImageServerwideResetDays(serverId, days, serverwideActive),

  getTextConfig: (serverId) => getOrCreateTextConfig(serverId),
  updateTextDailyUserQuota: (serverId, limit) => updateTextDailyUserQuota(serverId, limit),
  updateTextServerwideQuota: (serverId, limit, currentResetDays, previousLimit) =>
    updateTextServerwideQuota(serverId, limit, currentResetDays, previousLimit),
  updateTextServerwideResetDays: (serverId, days, serverwideActive) =>
    updateTextServerwideResetDays(serverId, days, serverwideActive),

  getVideoConfig: (serverId) => getOrCreateVideoConfig(serverId),
  updateVideoDailyUserQuota: (serverId, limit) => updateVideoDailyUserQuota(serverId, limit),
  updateVideoServerwideQuota: (serverId, limit, currentResetDays, previousLimit) =>
    updateVideoServerwideQuota(serverId, limit, currentResetDays, previousLimit),
  updateVideoServerwideResetDays: (serverId, days, serverwideActive) =>
    updateVideoServerwideResetDays(serverId, days, serverwideActive),
};

export async function updateQuotaSettings(
  input: UpdateQuotaSettingsInput,
  deps: QuotaOperationsDependencies = defaultQuotaOperationsDependencies,
): Promise<UpdateQuotaSettingsResult> {
  const { serverId, quotaType, dailyUserQuota, serverwideQuota, serverwideQuotaResetsIn } = input;

  if (dailyUserQuota !== undefined && dailyUserQuota !== null) {
    if (
      typeof dailyUserQuota !== "number" ||
      !Number.isInteger(dailyUserQuota) ||
      dailyUserQuota < 0 ||
      dailyUserQuota > 100
    ) {
      return { status: "invalid", quotaType, reason: "daily_user_quota must be an integer between 0 and 100" };
    }
  }

  if (serverwideQuota !== undefined && serverwideQuota !== null) {
    if (
      typeof serverwideQuota !== "number" ||
      !Number.isInteger(serverwideQuota) ||
      serverwideQuota < 0 ||
      serverwideQuota > 99999
    ) {
      return { status: "invalid", quotaType, reason: "serverwide_quota must be an integer between 0 and 99999" };
    }
  }

  if (serverwideQuotaResetsIn !== undefined && serverwideQuotaResetsIn !== null) {
    if (
      typeof serverwideQuotaResetsIn !== "number" ||
      !Number.isInteger(serverwideQuotaResetsIn) ||
      serverwideQuotaResetsIn < 1 ||
      serverwideQuotaResetsIn > 365
    ) {
      return {
        status: "invalid",
        quotaType,
        reason: "serverwide_quota_resets_in must be an integer between 1 and 365",
      };
    }
  }

  const appliedFields: Array<"daily_user_quota" | "serverwide_quota" | "serverwide_quota_resets_in"> = [];

  try {
    if (quotaType === "image") {
      if (dailyUserQuota !== undefined && dailyUserQuota !== null) {
        await deps.getImageConfig(serverId);
        await deps.updateImageDailyUserQuota(serverId, dailyUserQuota);
        appliedFields.push("daily_user_quota");
      }
      if (serverwideQuota !== undefined && serverwideQuota !== null) {
        const currentConfig = await deps.getImageConfig(serverId);
        await deps.updateImageServerwideQuota(
          serverId,
          serverwideQuota,
          currentConfig.serverwide_quota_resets_in,
          currentConfig.serverwide_quota,
        );
        appliedFields.push("serverwide_quota");
      }
      if (serverwideQuotaResetsIn !== undefined && serverwideQuotaResetsIn !== null) {
        const currentConfig = await deps.getImageConfig(serverId);
        await deps.updateImageServerwideResetDays(
          serverId,
          serverwideQuotaResetsIn,
          currentConfig.serverwide_quota > 0,
        );
        appliedFields.push("serverwide_quota_resets_in");
      }
    } else if (quotaType === "text") {
      if (dailyUserQuota !== undefined && dailyUserQuota !== null) {
        await deps.getTextConfig(serverId);
        await deps.updateTextDailyUserQuota(serverId, dailyUserQuota);
        appliedFields.push("daily_user_quota");
      }
      if (serverwideQuota !== undefined && serverwideQuota !== null) {
        const currentConfig = await deps.getTextConfig(serverId);
        await deps.updateTextServerwideQuota(
          serverId,
          serverwideQuota,
          currentConfig.serverwide_quota_resets_in,
          currentConfig.serverwide_quota,
        );
        appliedFields.push("serverwide_quota");
      }
      if (serverwideQuotaResetsIn !== undefined && serverwideQuotaResetsIn !== null) {
        const currentConfig = await deps.getTextConfig(serverId);
        await deps.updateTextServerwideResetDays(serverId, serverwideQuotaResetsIn, currentConfig.serverwide_quota > 0);
        appliedFields.push("serverwide_quota_resets_in");
      }
    } else if (quotaType === "video") {
      if (dailyUserQuota !== undefined && dailyUserQuota !== null) {
        await deps.getVideoConfig(serverId);
        await deps.updateVideoDailyUserQuota(serverId, dailyUserQuota);
        appliedFields.push("daily_user_quota");
      }
      if (serverwideQuota !== undefined && serverwideQuota !== null) {
        const currentConfig = await deps.getVideoConfig(serverId);
        await deps.updateVideoServerwideQuota(
          serverId,
          serverwideQuota,
          currentConfig.serverwide_quota_resets_in,
          currentConfig.serverwide_quota,
        );
        appliedFields.push("serverwide_quota");
      }
      if (serverwideQuotaResetsIn !== undefined && serverwideQuotaResetsIn !== null) {
        const currentConfig = await deps.getVideoConfig(serverId);
        await deps.updateVideoServerwideResetDays(
          serverId,
          serverwideQuotaResetsIn,
          currentConfig.serverwide_quota > 0,
        );
        appliedFields.push("serverwide_quota_resets_in");
      }
    }

    return {
      status: "success",
      quotaType,
      appliedFields,
    };
  } catch (error) {
    return {
      status: "failed",
      quotaType,
      error,
    };
  }
}

export interface ModerationOperations {
  updateMemberPermissions(
    input: UpdateMemberPermissionsInput,
    deps?: MemberPermissionsOperationsDependencies,
  ): Promise<UpdateMemberPermissionsResult>;
  updateServerModelAccess(
    input: UpdateServerModelAccessInput,
    deps?: ServerModelAccessOperationsDependencies,
  ): Promise<UpdateServerModelAccessResult>;
  addUserToBlacklist(
    input: AddUserToBlacklistInput,
    deps?: UserBlacklistOperationsDependencies,
  ): Promise<AddUserToBlacklistResult>;
  removeUserFromBlacklist(
    input: RemoveUserFromBlacklistInput,
    deps?: RemoveUserBlacklistOperationsDependencies,
  ): Promise<RemoveUserFromBlacklistResult>;
  removePersonaUserBlock(
    input: RemovePersonaUserBlockInput,
    deps?: RemovePersonaUserBlockOperationsDependencies,
  ): Promise<RemovePersonaUserBlockResult>;
  removeUserBlacklistBatch(
    input: RemoveUserBlacklistBatchInput,
    deps?: RemoveUserBlacklistBatchOperationsDependencies,
  ): Promise<RemoveUserBlacklistBatchResult>;
  upsertWhitelistChannel(
    input: UpsertWhitelistChannelInput,
    deps?: WhitelistChannelOperationsDependencies,
  ): Promise<UpsertWhitelistChannelResult>;
  removeWhitelistChannel(
    input: RemoveWhitelistChannelInput,
    deps?: RemoveWhitelistChannelOperationsDependencies,
  ): Promise<RemoveWhitelistChannelResult>;
  addWhitelistRole(
    input: AddWhitelistRoleInput,
    deps?: AddWhitelistRoleOperationsDependencies,
  ): Promise<AddWhitelistRoleResult>;
  removeWhitelistRole(
    input: AddWhitelistRoleInput,
    deps?: RemoveWhitelistRoleOperationsDependencies,
  ): Promise<RemoveWhitelistRoleResult>;
  replacePersonaChannelWhitelist(
    input: ReplacePersonaChannelWhitelistInput,
    deps?: ReplacePersonaChannelWhitelistDependencies,
  ): Promise<ReplacePersonaChannelWhitelistResult>;
  updateQuotaSettings(
    input: UpdateQuotaSettingsInput,
    deps?: QuotaOperationsDependencies,
  ): Promise<UpdateQuotaSettingsResult>;
}

export const moderationOperations: ModerationOperations = {
  updateMemberPermissions,
  updateServerModelAccess,
  addUserToBlacklist,
  removeUserFromBlacklist,
  removePersonaUserBlock,
  removeUserBlacklistBatch,
  upsertWhitelistChannel,
  removeWhitelistChannel,
  addWhitelistRole,
  removeWhitelistRole,
  replacePersonaChannelWhitelist,
  updateQuotaSettings,
};
