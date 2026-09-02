import type { Attachment, APIAttachment } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { ConditioningGroup } from "@/utils/db/repositories/ConditioningMemoryRepository";
import {
  personaNamingConfigSchema,
  validatePersonaNamingAuthoring,
  type AddressingStyle,
  type PersonaNamingConfig,
} from "@/types/personaNaming";
import { invalidateTomoriStateCache } from "@/utils/cache/tomoriStateCache";
import { conditioningMemoryRepository } from "@/utils/db/repositories/ConditioningMemoryRepository";
import { personaRepository } from "@/utils/db/repositories";
import { shortTermMemoryRepository } from "@/utils/db/repositories/ShortTermMemoryRepository";
import { convertToPNG } from "@/utils/image/imageProcessor";
import {
  getMemoryLimits,
  validateAttribute,
  validateMemoryContent,
  validateSampleDialogue,
} from "@/utils/misc/memoryLimits";
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
import {
  dedupeCaseInsensitive,
  dedupeSampleDialoguePairs,
  getNonEmptyNumberedLines,
  parseSampleDialogueBatch,
  readTxtUpload,
} from "@/utils/teach/batchUploadUtils";

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

export type ConfigStmEditResult = { status: "success" } | { status: "write-failed" };

export type ConfigConditioningRemoveResult =
  | { status: "success"; deletedRows: number }
  | { status: "no-removals" }
  | { status: "write-failed" };

export type ConfigAttributeAddResult =
  | { status: "success"; addedAttributes: string[]; selectedIndex: number }
  | { status: "invalid-file"; error: "invalid_format" | "file_too_large" | "download_failed" }
  | { status: "no-input" }
  | { status: "content-too-long"; currentLength: number; maxAllowed: number }
  | { status: "duplicate"; attribute: string }
  | {
      status: "limit-exceeded";
      currentCount: number;
      maxAllowed: number;
      importCount: number;
      removeCount: number;
      batch: boolean;
    }
  | { status: "write-failed" };

export type ConfigAttributeEditResult =
  | { status: "success" }
  | { status: "unchanged" }
  | { status: "content-too-long"; currentLength: number; maxAllowed: number }
  | { status: "duplicate"; attribute: string }
  | { status: "write-failed" };

export type ConfigAttributeRemoveResult = { status: "success"; removedAttribute: string } | { status: "write-failed" };

export type ConfigDialogueAddResult =
  | { status: "success"; addedDialogues: Array<{ userInput: string; botInput: string }>; selectedIndex: number }
  | { status: "invalid-file"; error: "invalid_format" | "file_too_large" | "download_failed" }
  | { status: "manual-pair-required" }
  | { status: "invalid-batch"; lineNumber: number; invalidBotPrefix: boolean }
  | { status: "no-input" }
  | { status: "user-too-long"; currentLength: number; maxAllowed: number }
  | { status: "bot-too-long"; currentLength: number; maxAllowed: number }
  | { status: "duplicate"; input: string }
  | {
      status: "limit-exceeded";
      currentCount: number;
      maxAllowed: number;
      importCount: number;
      removeCount: number;
      batch: boolean;
    }
  | { status: "write-failed" };

export type ConfigDialogueEditResult =
  | { status: "success" }
  | { status: "unchanged" }
  | { status: "user-too-long"; currentLength: number; maxAllowed: number }
  | { status: "bot-too-long"; currentLength: number; maxAllowed: number }
  | { status: "duplicate"; input: string }
  | { status: "write-failed" };

export type ConfigDialogueRemoveResult =
  | { status: "success"; removedInput: string; removedOutput: string }
  | { status: "write-failed" };

export type ConfigDialogueRepairResult =
  | { status: "not-needed"; inputs: string[]; outputs: string[] }
  | { status: "repaired"; inputs: string[]; outputs: string[] }
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
  addAttributes(input: {
    persona: TomoriState;
    serverDiscId: string;
    typedAttribute: string;
    uploadedFile?: APIAttachment;
    isPublic: boolean;
  }): Promise<ConfigAttributeAddResult>;
  editAttribute(input: {
    persona: TomoriState;
    serverDiscId: string;
    index: number;
    newAttribute: string;
    isPublic?: boolean;
  }): Promise<ConfigAttributeEditResult>;
  removeAttribute(input: {
    persona: TomoriState;
    serverDiscId: string;
    index: number;
  }): Promise<ConfigAttributeRemoveResult>;
  addSampleDialogues(input: {
    persona: TomoriState;
    serverDiscId: string;
    typedUserInput: string;
    typedBotInput: string;
    uploadedFile?: APIAttachment;
  }): Promise<ConfigDialogueAddResult>;
  editSampleDialogue(input: {
    persona: TomoriState;
    serverDiscId: string;
    index: number;
    newInput: string;
    newOutput: string;
  }): Promise<ConfigDialogueEditResult>;
  removeSampleDialogue(input: {
    persona: TomoriState;
    serverDiscId: string;
    index: number;
  }): Promise<ConfigDialogueRemoveResult>;
  repairSampleDialogues(input: { persona: TomoriState; serverDiscId: string }): Promise<ConfigDialogueRepairResult>;
  editStm(input: {
    userDiscId: string;
    channelId: string;
    serverDiscId: string;
    serverName?: string;
    channelName?: string;
    parentChannelId?: string | null;
    personaId: number;
    personaLineageId: number;
    mode: "summary" | "categories";
    summary?: string;
    categories?: Record<string, string>;
  }): Promise<ConfigStmEditResult>;
  removeConditioning(input: {
    serverId: number;
    personaLineageId: number;
    groups: Array<Pick<ConditioningGroup, "conditioningType" | "actionKey" | "reasonNormalized">>;
  }): Promise<ConfigConditioningRemoveResult>;
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

  async addAttributes({ persona, serverDiscId, typedAttribute, uploadedFile, isPublic }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const memoryLimits = getMemoryLimits();
    const pendingAttributes: string[] = [];
    const trimmedAttribute = typedAttribute.trim();
    if (trimmedAttribute) pendingAttributes.push(trimmedAttribute);

    if (uploadedFile) {
      const uploadResult = await readTxtUpload(uploadedFile);
      if (!uploadResult.isValid || !uploadResult.text) {
        return { status: "invalid-file", error: uploadResult.error ?? "download_failed" };
      }
      pendingAttributes.push(...getNonEmptyNumberedLines(uploadResult.text).map((line) => line.content));
    }

    if (pendingAttributes.length === 0) return { status: "no-input" };

    const dedupedAttributes = dedupeCaseInsensitive(pendingAttributes);
    for (const attribute of dedupedAttributes) {
      const validation = validateAttribute(attribute);
      if (!validation.isValid) {
        return {
          status: "content-too-long",
          currentLength: attribute.length,
          maxAllowed: validation.maxAllowed || memoryLimits.maxAttributeLength,
        };
      }
    }

    const currentAttributes = persona.attribute_list ?? [];
    const existingAttributes = new Set(currentAttributes.map((attribute) => attribute.trim().toLowerCase()));
    const attributesToAdd = dedupedAttributes.filter((attribute) => !existingAttributes.has(attribute.toLowerCase()));
    if (attributesToAdd.length === 0) {
      return { status: "duplicate", attribute: dedupedAttributes[0] ?? trimmedAttribute };
    }

    const limit = await personaRepository.checkAttributeLimit(personaId);
    const currentCount = limit.currentCount ?? currentAttributes.length;
    const maxAllowed = limit.maxAllowed ?? memoryLimits.maxAttributes;
    const availableSlots = Math.max(0, maxAllowed - currentCount);
    if (attributesToAdd.length > availableSlots) {
      return {
        status: "limit-exceeded",
        currentCount,
        maxAllowed,
        importCount: attributesToAdd.length,
        removeCount: attributesToAdd.length - availableSlots,
        batch: Boolean(uploadedFile),
      };
    }

    if (!(await personaRepository.addAttributes(personaId, attributesToAdd, isPublic))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      addedAttributes: attributesToAdd,
      selectedIndex: currentAttributes.length + attributesToAdd.length - 1,
    };
  },

  async editAttribute({ persona, serverDiscId, index, newAttribute, isPublic }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const memoryLimits = getMemoryLimits();
    const currentAttributes = persona.attribute_list ?? [];
    const currentAttribute = currentAttributes[index];
    if (currentAttribute === undefined) return { status: "write-failed" };

    const currentIsPublic =
      persona.persona_attributes?.find((attribute) => attribute.attribute_order === index + 1)?.is_public ?? false;
    const validation = validateAttribute(newAttribute);
    if (!validation.isValid) {
      return {
        status: "content-too-long",
        currentLength: newAttribute.length,
        maxAllowed: validation.maxAllowed || memoryLimits.maxAttributeLength,
      };
    }

    const nextIsPublic = isPublic ?? currentIsPublic;
    if (newAttribute === currentAttribute.trim() && nextIsPublic === currentIsPublic) {
      return { status: "unchanged" };
    }

    const duplicateExists = currentAttributes.some(
      (attribute, attributeIndex) =>
        attributeIndex !== index && attribute.trim().toLowerCase() === newAttribute.toLowerCase(),
    );
    if (duplicateExists) return { status: "duplicate", attribute: newAttribute };

    if (!(await personaRepository.editAttributeAt(personaId, index + 1, newAttribute, isPublic))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success" };
  },

  async removeAttribute({ persona, serverDiscId, index }) {
    const personaId = persona.persona_id;
    const attribute = persona.attribute_list?.[index];
    if (!personaId || attribute === undefined) return { status: "write-failed" };

    if (!(await personaRepository.removeAttributeAt(personaId, index + 1))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", removedAttribute: attribute };
  },

  async addSampleDialogues({ persona, serverDiscId, typedUserInput, typedBotInput, uploadedFile }) {
    const personaId = persona.persona_id;
    if (!personaId) return { status: "write-failed" };

    const memoryLimits = getMemoryLimits();
    const pendingDialogues: Array<{ userInput: string; botInput: string }> = [];
    const trimmedUserInput = typedUserInput.trim();
    const trimmedBotInput = typedBotInput.trim();
    if (trimmedUserInput || trimmedBotInput) {
      if (!trimmedUserInput || !trimmedBotInput) return { status: "manual-pair-required" };
      pendingDialogues.push({ userInput: trimmedUserInput, botInput: trimmedBotInput });
    }

    if (uploadedFile) {
      const uploadResult = await readTxtUpload(uploadedFile);
      if (!uploadResult.isValid || !uploadResult.text) {
        return { status: "invalid-file", error: uploadResult.error ?? "download_failed" };
      }
      const parsedBatch = parseSampleDialogueBatch(uploadResult.text);
      if (!parsedBatch.isValid) {
        return {
          status: "invalid-batch",
          lineNumber: parsedBatch.error?.lineNumber ?? 1,
          invalidBotPrefix: parsedBatch.error?.code === "invalid_bot_prefix",
        };
      }
      pendingDialogues.push(...parsedBatch.pairs);
    }

    if (pendingDialogues.length === 0) return { status: "no-input" };

    const dedupedDialogues = dedupeSampleDialoguePairs(pendingDialogues);
    for (const dialogue of dedupedDialogues) {
      const userValidation = validateSampleDialogue(dialogue.userInput);
      if (!userValidation.isValid) {
        return {
          status: "user-too-long",
          currentLength: dialogue.userInput.length,
          maxAllowed: userValidation.maxAllowed || memoryLimits.maxSampleDialogueLength,
        };
      }
      const botValidation = validateSampleDialogue(dialogue.botInput);
      if (!botValidation.isValid) {
        return {
          status: "bot-too-long",
          currentLength: dialogue.botInput.length,
          maxAllowed: botValidation.maxAllowed || memoryLimits.maxSampleDialogueLength,
        };
      }
    }

    const currentInputs = persona.sample_dialogues_in ?? [];
    const currentOutputs = persona.sample_dialogues_out ?? [];
    const existingDialogues = new Set<string>();
    const existingLength = Math.min(currentInputs.length, currentOutputs.length);
    for (let index = 0; index < existingLength; index += 1) {
      existingDialogues.add(
        `${currentInputs[index]?.trim().toLowerCase()}|||${currentOutputs[index]?.trim().toLowerCase()}`,
      );
    }
    const dialoguesToAdd = dedupedDialogues.filter(
      (dialogue) => !existingDialogues.has(`${dialogue.userInput.toLowerCase()}|||${dialogue.botInput.toLowerCase()}`),
    );
    if (dialoguesToAdd.length === 0) {
      return { status: "duplicate", input: dedupedDialogues[0]?.userInput ?? trimmedUserInput };
    }

    const limit = await personaRepository.checkSampleDialogueLimit(personaId);
    const currentCount = limit.currentCount ?? currentInputs.length;
    const maxAllowed = limit.maxAllowed ?? memoryLimits.maxSampleDialogues;
    const availableSlots = Math.max(0, maxAllowed - currentCount);
    if (dialoguesToAdd.length > availableSlots) {
      return {
        status: "limit-exceeded",
        currentCount,
        maxAllowed,
        importCount: dialoguesToAdd.length,
        removeCount: dialoguesToAdd.length - availableSlots,
        batch: Boolean(uploadedFile),
      };
    }

    if (
      !(await personaRepository.addSampleDialoguePair(
        personaId,
        dialoguesToAdd.map((dialogue) => dialogue.userInput),
        dialoguesToAdd.map((dialogue) => dialogue.botInput),
      ))
    ) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return {
      status: "success",
      addedDialogues: dialoguesToAdd,
      selectedIndex: currentInputs.length + dialoguesToAdd.length - 1,
    };
  },

  async editSampleDialogue({ persona, serverDiscId, index, newInput, newOutput }) {
    const personaId = persona.persona_id;
    const currentInput = persona.sample_dialogues_in?.[index];
    const currentOutput = persona.sample_dialogues_out?.[index];
    if (!personaId || currentInput === undefined || currentOutput === undefined) return { status: "write-failed" };

    const memoryLimits = getMemoryLimits();
    const inputValidation = validateSampleDialogue(newInput);
    if (!inputValidation.isValid) {
      return {
        status: "user-too-long",
        currentLength: newInput.length,
        maxAllowed: inputValidation.maxAllowed || memoryLimits.maxSampleDialogueLength,
      };
    }
    const outputValidation = validateSampleDialogue(newOutput);
    if (!outputValidation.isValid) {
      return {
        status: "bot-too-long",
        currentLength: newOutput.length,
        maxAllowed: outputValidation.maxAllowed || memoryLimits.maxSampleDialogueLength,
      };
    }
    if (newInput === currentInput.trim() && newOutput === currentOutput.trim()) return { status: "unchanged" };

    const inputs = persona.sample_dialogues_in ?? [];
    const outputs = persona.sample_dialogues_out ?? [];
    const duplicateExists = inputs.some(
      (input, inputIndex) =>
        inputIndex !== index &&
        `${input.trim().toLowerCase()}|||${outputs[inputIndex]?.trim().toLowerCase()}` ===
          `${newInput.toLowerCase()}|||${newOutput.toLowerCase()}`,
    );
    if (duplicateExists) return { status: "duplicate", input: newInput };

    if (!(await personaRepository.editSampleDialoguePairAt(personaId, index + 1, newInput, newOutput))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success" };
  },

  async removeSampleDialogue({ persona, serverDiscId, index }) {
    const personaId = persona.persona_id;
    const removedInput = persona.sample_dialogues_in?.[index];
    const removedOutput = persona.sample_dialogues_out?.[index];
    if (!personaId || removedInput === undefined || removedOutput === undefined) return { status: "write-failed" };

    if (!(await personaRepository.removeSampleDialoguePairAt(personaId, index + 1))) {
      return { status: "write-failed" };
    }

    invalidateTomoriStateCache(serverDiscId);
    return { status: "success", removedInput, removedOutput };
  },

  async repairSampleDialogues({ persona, serverDiscId }) {
    const personaId = persona.persona_id;
    const inputs = [...(persona.sample_dialogues_in ?? [])];
    const outputs = [...(persona.sample_dialogues_out ?? [])];
    if (!personaId) return { status: "write-failed" };
    if (inputs.length === outputs.length) return { status: "not-needed", inputs, outputs };

    const safeLength = Math.min(inputs.length, outputs.length);
    log.warn(
      `Self-healing: truncating sample dialogues for persona ${personaId} from (in: ${inputs.length}, out: ${outputs.length}) to ${safeLength} pairs`,
    );
    const repaired = await personaRepository.repairSampleDialogues(personaId, safeLength);
    if (!repaired) return { status: "write-failed" };

    invalidateTomoriStateCache(serverDiscId);
    return { status: "repaired", inputs: repaired.repairedIn, outputs: repaired.repairedOut };
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

  async editStm({
    userDiscId,
    channelId,
    serverDiscId,
    serverName,
    channelName,
    parentChannelId,
    personaId,
    personaLineageId,
    mode,
    summary,
    categories,
  }) {
    if (mode === "categories") {
      await shortTermMemoryRepository.updateCategories(
        userDiscId,
        channelId,
        categories ?? {},
        serverDiscId,
        serverName,
        channelName,
        personaId,
        personaLineageId,
        parentChannelId,
      );
      return { status: "success" };
    }

    // Summary and clear update the cache synchronously and let their durable write float, while
    // the categories writer is genuinely async. The panel repaints from that cache, so awaiting
    // these two would buy nothing and would put the STM tool's hot path behind two database round
    // trips, which is what the absorbed command already avoids.
    if (summary?.trim()) {
      shortTermMemoryRepository.updateSummary(
        userDiscId,
        channelId,
        summary.trim(),
        serverDiscId,
        serverName,
        channelName,
        personaId,
        personaLineageId,
        parentChannelId,
      );
    } else {
      shortTermMemoryRepository.clearSummary(userDiscId, channelId, personaId, serverDiscId);
    }
    return { status: "success" };
  },

  async removeConditioning({ serverId, personaLineageId, groups }) {
    if (groups.length === 0) return { status: "no-removals" };
    const deletedRows = await conditioningMemoryRepository.deleteGroupsForPersona(serverId, personaLineageId, groups);
    return deletedRows > 0 ? { status: "success", deletedRows } : { status: "no-removals" };
  },
};
