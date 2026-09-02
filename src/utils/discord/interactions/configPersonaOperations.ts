import type { Attachment, APIAttachment } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import {
  personaNamingConfigSchema,
  validatePersonaNamingAuthoring,
  type AddressingStyle,
  type PersonaNamingConfig,
} from "@/types/personaNaming";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { personaRepository } from "@/utils/db/repositories";
import { convertToPNG } from "@/utils/image/imageProcessor";
import { getMemoryLimits, validateMemoryContent } from "@/utils/misc/memoryLimits";
import { forkPointerForAvatarChange } from "@/utils/persona/pointerFork";
import { PERSONA_LIMITS, memoryGuard, reserveAvatarQuota } from "@/utils/security/rateLimiter";
import { safeDownload } from "@/utils/security/safeDownload";
import {
  deletePersonaAvatarFromStorage,
  loadStoredPersonaAvatarBuffer,
  uploadPersonaAvatarToStorage,
} from "@/utils/storage/avatarStorage";
import { normalizeTriggerWord, parseTriggerWordListInput } from "@/utils/text/triggerWords";
import { log } from "@/utils/misc/logger";

export const PERSONA_NICKNAME_MIN_LENGTH = 2;
export const PERSONA_NICKNAME_MAX_LENGTH = 32;

const AVATAR_DOWNLOAD_TIMEOUT_MS = 15000;

type ConfigAvatarAttachment = Attachment | APIAttachment;

/**
 * The Discord-side effects the two identity operations need. Guild nickname and guild avatar are
 * REST writes rather than repository writes, so they arrive as a port: the operation stays testable
 * and the route layer owns the transport.
 */
export interface GuildIdentityPort {
  setNickname(nickname: string): Promise<boolean>;
  setAvatar(avatarDataUri: string | null): Promise<{ ok: boolean; rateLimited: boolean; details?: string }>;
  currentAvatarReference(): Promise<string | null>;
}

type ConfigRenameResult =
  | { status: "success"; oldNickname: string; newNickname: string; triggerAdded: boolean; guildNicknameSynced: boolean }
  | { status: "invalid-length" }
  | { status: "unchanged"; nickname: string }
  | { status: "name-conflict"; nickname: string }
  | { status: "write-failed" }
  | { status: "trigger-write-failed"; oldNickname: string; newNickname: string };

type ConfigNamingResult =
  | { status: "success"; style: AddressingStyle }
  | { status: "invalid-config" }
  | { status: "write-failed" };

type ConfigTriggerAddResult =
  | { status: "success"; addedTriggers: string[]; totalCount: number }
  | { status: "no-triggers" }
  | { status: "too-short" }
  | { status: "content-too-long"; maxLength: number }
  | { status: "already-exists"; attempted: string[] }
  | { status: "limit-exceeded"; currentCount: number; maxAllowed: number }
  | { status: "write-failed" };

type ConfigTriggerRemoveResult =
  | { status: "success"; removedTriggers: string[] }
  | { status: "no-removals" }
  | { status: "write-failed" };

type ConfigAvatarResult =
  | { status: "success"; scope: "main" | "alter"; cleared: boolean }
  | { status: "memory-critical" }
  | { status: "pointer-fork-failed" }
  | { status: "quota-exceeded"; resetAt: number | null }
  | { status: "invalid-image"; reason: "file-too-large" | "invalid-format" }
  | { status: "download-failed"; reason: "size_exceeded" | "timeout" | "other" }
  | { status: "conversion-failed" }
  | { status: "storage-failed" }
  | { status: "guild-avatar-rate-limited" }
  | { status: "guild-avatar-failed"; details?: string };

type ConfigPromoteResult =
  | {
      status: "success";
      newMainNickname: string;
      formerMainNickname: string;
      nicknameSynced: boolean;
      avatarSynced: boolean;
      avatarRateLimited: boolean;
      avatarAttempted: boolean;
    }
  | { status: "not-alter" }
  | { status: "no-main-persona" }
  | { status: "write-failed" };

export interface ConfigPersonaOperations {
  rename(input: {
    persona: TomoriState;
    serverDiscId: string;
    newNickname: string;
    guildIdentity: GuildIdentityPort | null;
  }): Promise<ConfigRenameResult>;
  setNamingHabits(input: {
    persona: TomoriState;
    serverDiscId: string;
    style: AddressingStyle;
    prefix: string;
    suffix: string;
    addressTerm: string;
  }): Promise<ConfigNamingResult>;
  addTriggers(input: { persona: TomoriState; serverDiscId: string; rawInput: string }): Promise<ConfigTriggerAddResult>;
  removeTriggers(input: {
    persona: TomoriState;
    serverDiscId: string;
    removedIndices: readonly number[];
  }): Promise<ConfigTriggerRemoveResult>;
  replaceAvatar(input: {
    persona: TomoriState;
    serverDiscId: string;
    guildId: string;
    attachment: ConfigAvatarAttachment | null;
    guildIdentity: GuildIdentityPort;
  }): Promise<ConfigAvatarResult>;
  promoteToMain(input: {
    alterPersona: TomoriState;
    mainPersona: TomoriState | null;
    serverDiscId: string;
    guildId: string;
    guildIdentity: GuildIdentityPort;
  }): Promise<ConfigPromoteResult>;
}

function updatedNamingMap(
  source: PersonaNamingConfig["prefixes"],
  style: AddressingStyle,
  value: string,
): PersonaNamingConfig["prefixes"] {
  const next = { ...source };
  if (value) next[style] = value;
  else delete next[style];
  return next;
}

function validateAvatarImage(
  attachment: ConfigAvatarAttachment,
): { ok: true } | { ok: false; reason: "file-too-large" | "invalid-format" } {
  const contentType = "contentType" in attachment ? attachment.contentType : attachment.content_type;
  const filename = "name" in attachment ? attachment.name : attachment.filename;

  if (attachment.size > PERSONA_LIMITS.MAX_AVATAR_SIZE_MB * 1024 * 1024) {
    return { ok: false, reason: "file-too-large" };
  }

  const allowedTypes = ["image/png", "image/jpeg", "image/jpg", "image/gif"];
  if (!contentType || !allowedTypes.includes(contentType)) {
    return { ok: false, reason: "invalid-format" };
  }

  // Discord metadata is caller-controlled, so the filename extension provides a second format check
  // before the file reaches image decoding.
  const allowedExtensions = ["png", "jpg", "jpeg", "gif"];
  const fileExtension = filename?.toLowerCase().split(".").pop();
  if (!fileExtension || !allowedExtensions.includes(fileExtension)) {
    return { ok: false, reason: "invalid-format" };
  }

  return { ok: true };
}

export const configPersonaOperations: ConfigPersonaOperations = {
  async rename({ persona, serverDiscId, newNickname, guildIdentity }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const trimmed = newNickname.trim();
    if (trimmed.length < PERSONA_NICKNAME_MIN_LENGTH || trimmed.length > PERSONA_NICKNAME_MAX_LENGTH) {
      return { status: "invalid-length" };
    }

    const oldNickname = persona.persona_nickname;
    if (trimmed === oldNickname) return { status: "unchanged", nickname: trimmed };

    if (await personaRepository.hasNicknameConflict(persona.server_id, personaId, trimmed)) {
      return { status: "name-conflict", nickname: trimmed };
    }

    if (!(await personaRepository.renamePersona(personaId, trimmed))) {
      if (await personaRepository.hasNicknameConflict(persona.server_id, personaId, trimmed)) {
        return { status: "name-conflict", nickname: trimmed };
      }
      return { status: "write-failed" };
    }

    const currentTriggers = persona.trigger_words ?? [];
    const needsTrigger = !currentTriggers.some(
      (trigger) => normalizeTriggerWord(trigger) === normalizeTriggerWord(trimmed),
    );
    if (needsTrigger && !(await personaRepository.addTrigger(personaId, [trimmed]))) {
      // The rename itself already committed, so the caller reports a partial success rather than a
      // failure that would suggest the old name survived.
      invalidateTomoriStateCache(serverDiscId);
      return { status: "trigger-write-failed", oldNickname, newNickname: trimmed };
    }

    // Only the main persona speaks through the bot account, so only its rename touches the guild
    // nickname. The sync is non-fatal: a missing Change Nickname permission must not fail the write.
    let guildNicknameSynced = false;
    if (guildIdentity && persona.is_alter !== true) {
      guildNicknameSynced = await guildIdentity.setNickname(trimmed);
    }

    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      oldNickname,
      newNickname: trimmed,
      triggerAdded: needsTrigger,
      guildNicknameSynced,
    };
  },

  async setNamingHabits({ persona, serverDiscId, style, prefix, suffix, addressTerm }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const current = persona.naming_config;
    const parsed = personaNamingConfigSchema.safeParse({
      prefixes: updatedNamingMap(current.prefixes, style, prefix.trim()),
      suffixes: updatedNamingMap(current.suffixes, style, suffix.trim()),
      addressTerms: updatedNamingMap(current.addressTerms, style, addressTerm.trim()),
    });
    if (!parsed.success) return { status: "invalid-config" };

    try {
      validatePersonaNamingAuthoring(parsed.data, [
        persona.persona_prompt ?? "",
        ...(persona.attribute_list ?? []),
        ...(persona.sample_dialogues_in ?? []),
        ...(persona.sample_dialogues_out ?? []),
      ]);
    } catch {
      return { status: "invalid-config" };
    }

    if (!(await personaRepository.updateNamingConfig(personaId, parsed.data))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", style };
  },

  async addTriggers({ persona, serverDiscId, rawInput }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const memoryLimits = getMemoryLimits();
    const uniqueTriggers = parseTriggerWordListInput(rawInput);
    if (uniqueTriggers.length === 0) return { status: "no-triggers" };

    for (const trigger of uniqueTriggers) {
      if (trigger.length < 2) return { status: "too-short" };
      if (!validateMemoryContent(trigger).isValid) {
        return { status: "content-too-long", maxLength: memoryLimits.maxMemoryLength };
      }
    }

    const currentTriggers = persona.trigger_words ?? [];
    const existing = new Set(currentTriggers.map((trigger) => normalizeTriggerWord(trigger)));
    const newTriggers = uniqueTriggers.filter((trigger) => !existing.has(trigger));
    if (newTriggers.length === 0) return { status: "already-exists", attempted: uniqueTriggers };

    const totalCount = currentTriggers.length + newTriggers.length;
    if (totalCount > memoryLimits.maxTriggerWords) {
      return {
        status: "limit-exceeded",
        currentCount: currentTriggers.length,
        maxAllowed: memoryLimits.maxTriggerWords,
      };
    }

    if (!(await personaRepository.addTrigger(personaId, newTriggers))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", addedTriggers: newTriggers, totalCount };
  },

  async removeTriggers({ persona, serverDiscId, removedIndices }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const currentTriggers = persona.trigger_words ?? [];
    const removedIndexSet = new Set(removedIndices);
    const removedTriggers = currentTriggers.filter((_, index) => removedIndexSet.has(index));
    const remainingTriggers = currentTriggers.filter((_, index) => !removedIndexSet.has(index));
    if (removedTriggers.length === 0) return { status: "no-removals" };

    if (!(await personaRepository.removeTrigger(personaId, remainingTriggers))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", removedTriggers };
  },

  async replaceAvatar({ persona, serverDiscId, guildId, attachment, guildIdentity }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "storage-failed" };

    if (memoryGuard.checkMemory().status === "critical") return { status: "memory-critical" };

    if (!(await forkPointerForAvatarChange(persona))) return { status: "pointer-fork-failed" };

    const quota = reserveAvatarQuota(guildId);
    if (!quota.allowed) return { status: "quota-exceeded", resetAt: quota.resetAt ?? null };

    const isMainPersona = !persona.is_alter;

    if (!attachment) {
      if (isMainPersona) {
        // The main persona's avatar lives on the guild member, not in a column, so clearing it is a
        // REST write with no row to update and no cache to invalidate.
        const cleared = await guildIdentity.setAvatar(null);
        if (!cleared.ok) {
          return cleared.rateLimited
            ? { status: "guild-avatar-rate-limited" }
            : { status: "guild-avatar-failed", details: cleared.details };
        }
        return { status: "success", scope: "main", cleared: true };
      }

      if (persona.webhook_avatar_url) {
        await deletePersonaAvatarFromStorage(persona.webhook_avatar_url);
      }
      await personaRepository.setAvatar(personaId, null);
      invalidateTomoriStateCache(serverDiscId);
      return { status: "success", scope: "alter", cleared: true };
    }

    const validation = validateAvatarImage(attachment);
    if (!validation.ok) return { status: "invalid-image", reason: validation.reason };

    const download = await safeDownload(attachment.url, {
      maxSizeMB: PERSONA_LIMITS.MAX_AVATAR_SIZE_MB,
      timeoutMs: AVATAR_DOWNLOAD_TIMEOUT_MS,
      knownSize: attachment.size,
    });
    if (!download.success || !download.buffer) {
      const reason = !download.success
        ? download.error === "size_exceeded"
          ? "size_exceeded"
          : download.error === "timeout"
            ? "timeout"
            : "other"
        : "other";
      return { status: "download-failed", reason };
    }

    // Discord returns 200 for a structurally corrupt PNG but stores an unservable asset, so every
    // avatar path re-encodes before upload rather than trusting the source bytes.
    let pngBuffer: Buffer;
    try {
      pngBuffer = await convertToPNG(download.buffer);
    } catch (error) {
      log.warn("Failed to convert selected persona avatar image to PNG", error);
      return { status: "conversion-failed" };
    }

    if (isMainPersona) {
      const applied = await guildIdentity.setAvatar(`data:image/png;base64,${pngBuffer.toString("base64")}`);
      if (!applied.ok) {
        return applied.rateLimited
          ? { status: "guild-avatar-rate-limited" }
          : { status: "guild-avatar-failed", details: applied.details };
      }
      return { status: "success", scope: "main", cleared: false };
    }

    const persistedAvatarUrl = await uploadPersonaAvatarToStorage({
      personaId,
      serverDiscId: guildId,
      label: "server avatar",
      buffer: pngBuffer,
    });
    if (!persistedAvatarUrl) return { status: "storage-failed" };

    // The old asset is deleted before the row points away from it only when the new upload already
    // succeeded, so a failed upload never strands the persona without an avatar.
    if (persona.webhook_avatar_url && persona.webhook_avatar_url !== persistedAvatarUrl) {
      await deletePersonaAvatarFromStorage(persona.webhook_avatar_url);
    }
    await personaRepository.setAvatar(personaId, persistedAvatarUrl);
    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", scope: "alter", cleared: false };
  },

  async promoteToMain({ alterPersona, mainPersona, serverDiscId, guildId, guildIdentity }) {
    if (alterPersona.is_alter !== true || !alterPersona.persona_id) return { status: "not-alter" };
    if (!mainPersona?.persona_id) return { status: "no-main-persona" };

    const previousMainAvatarUrl = mainPersona.webhook_avatar_url;
    const previousAlterAvatarUrl = alterPersona.webhook_avatar_url;

    // The bot's live guild avatar is what the outgoing main persona actually looked like, so it is
    // captured before the swap rather than reconstructed from the row afterwards.
    const formerMainAvatarReference = (await guildIdentity.currentAvatarReference()) ?? previousMainAvatarUrl ?? null;
    let formerMainAvatarBuffer: Buffer | null = null;
    if (formerMainAvatarReference) {
      try {
        formerMainAvatarBuffer = await loadStoredPersonaAvatarBuffer(formerMainAvatarReference);
      } catch (error) {
        log.warn("Failed to prefetch former main persona avatar before promotion (non-fatal)", error);
      }
    }

    if (!(await personaRepository.swapPersona(mainPersona.persona_id, alterPersona.persona_id))) {
      return { status: "write-failed" };
    }

    // Everything past the swap is non-fatal: the promotion has committed, and a Discord identity
    // call that fails must degrade to a warning rather than imply the promotion did not happen.
    const nicknameSynced = await guildIdentity.setNickname(alterPersona.persona_nickname);

    let avatarSynced = false;
    let avatarRateLimited = false;
    let promotedAvatarBuffer: Buffer | null = null;
    const avatarAttempted = Boolean(previousAlterAvatarUrl);
    if (previousAlterAvatarUrl) {
      try {
        const stored = await loadStoredPersonaAvatarBuffer(previousAlterAvatarUrl);
        if (stored) {
          promotedAvatarBuffer = await convertToPNG(stored);
          const applied = await guildIdentity.setAvatar(
            `data:image/png;base64,${promotedAvatarBuffer.toString("base64")}`,
          );
          avatarSynced = applied.ok;
          avatarRateLimited = applied.rateLimited;
        }
      } catch (error) {
        log.warn("Failed to apply promoted persona avatar to the guild (non-fatal)", error);
      }
    }

    invalidateTomoriStateCache(serverDiscId);

    if (formerMainAvatarBuffer) {
      try {
        const storedUrl = await uploadPersonaAvatarToStorage({
          personaId: mainPersona.persona_id,
          serverDiscId: guildId,
          label: "former main swap",
          buffer: formerMainAvatarBuffer,
        });
        if (storedUrl) {
          await personaRepository.setAvatar(mainPersona.persona_id, storedUrl);
          if (previousMainAvatarUrl && previousMainAvatarUrl !== storedUrl) {
            await deletePersonaAvatarFromStorage(previousMainAvatarUrl);
          }
        }
      } catch (error) {
        log.warn("Failed to store former main persona avatar after promotion (non-fatal)", error);
      }
    }

    if (promotedAvatarBuffer) {
      const promotedStoredUrl = await uploadPersonaAvatarToStorage({
        personaId: alterPersona.persona_id,
        serverDiscId: guildId,
        label: "selected alter swap",
        buffer: promotedAvatarBuffer,
      });
      if (promotedStoredUrl) {
        await personaRepository.setAvatar(alterPersona.persona_id, promotedStoredUrl);
        if (previousAlterAvatarUrl && previousAlterAvatarUrl !== promotedStoredUrl) {
          await deletePersonaAvatarFromStorage(previousAlterAvatarUrl);
        }
      }
    }

    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      newMainNickname: alterPersona.persona_nickname,
      formerMainNickname: mainPersona.persona_nickname,
      nicknameSynced,
      avatarSynced,
      avatarRateLimited,
      avatarAttempted,
    };
  },
};
