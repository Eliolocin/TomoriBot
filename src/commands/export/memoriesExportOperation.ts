import {
  AttachmentBuilder,
  EmbedBuilder,
  MessageFlags,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from "discord.js";
import { parsePersonaOptionId, resolveSelectedPersona } from "@/commands/stats/persona";
import type { ExportResult } from "@/types/db/dataExport";
import type { TomoriState } from "@/types/db/schema";
import type { StandardEmbedOptions } from "@/types/discord/embed";
import { exportRepository, personaRepository } from "@/utils/db/repositories";
import {
  isWorkspaceTransferAuthorized,
  resolveWorkspaceTransferKey,
} from "@/utils/discord/interactions/transferAuthorization";
import {
  buildTransferExportFileName,
  resolveTransferExportSubject,
  type TransferExportScope,
} from "@/utils/discord/transferExportFileName";
import { replyInfoEmbed } from "@/utils/discord/ui/embeds";
import { safeSelectOptionText } from "@/utils/discord/ui/interactionCore";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export type MemoryExportScope = TransferExportScope;

/** Discord answers an autocomplete request with at most this many choices. */
const MEMORY_EXPORT_PERSONA_CHOICES_MAX = 25;

/**
 * The scope choices each domain offers. The workspace domain has no account-global memory namespace, so its
 * single-lineage scope is the current main persona; only the personal domain has a true global scope.
 */
export const WORKSPACE_MEMORY_EXPORT_SELECTIONS = ["main", "persona", "all"] as const;
export const PERSONAL_MEMORY_EXPORT_SELECTIONS = ["global", "persona", "all"] as const;

export type WorkspaceMemoryExportSelection = (typeof WORKSPACE_MEMORY_EXPORT_SELECTIONS)[number];
export type PersonalMemoryExportSelection = (typeof PERSONAL_MEMORY_EXPORT_SELECTIONS)[number];

export type WorkspaceMemoryExportMode = { mode: "main" } | { mode: "persona"; personaId: number } | { mode: "all" };
export type PersonalMemoryExportMode =
  | { mode: "global" }
  | { mode: "persona"; personaLineageId: number }
  | { mode: "all" };

/** Keeps this helper out of slash-command registration; the loader scans every file in a command directory. */
export const isCommandEnabled = () => false;

export interface MemoryExportDependencies {
  exportWorkspaceMemories(serverDiscId: string, scope: WorkspaceMemoryExportMode): Promise<ExportResult>;
  exportPersonalMemories(userDiscId: string, scope: PersonalMemoryExportMode): Promise<ExportResult>;
  /**
   * Resolves the personas of the workspace the command addresses, including a DM-backed one. The database read is
   * deliberate: `persona` option values arrive from a client-rendered picker, so resolving one against a cached
   * list could refuse a persona that exists and cannot confirm one that was just deleted.
   */
  loadWorkspacePersonas(workspaceKey: string): Promise<TomoriState[]>;
  deliverDirectMessage(
    interaction: ChatInputCommandInteraction,
    payload: { embeds: EmbedBuilder[]; files: AttachmentBuilder[] },
  ): Promise<unknown>;
  replyInfoEmbed(
    interaction: ChatInputCommandInteraction,
    locale: string,
    options: StandardEmbedOptions,
    flags?: MessageFlags,
  ): Promise<void>;
}

const defaultDependencies: MemoryExportDependencies = {
  exportWorkspaceMemories: (serverDiscId, scope) => exportRepository.exportWorkspaceMemories(serverDiscId, scope),
  exportPersonalMemories: (userDiscId, scope) => exportRepository.exportPersonalMemories(userDiscId, scope),
  loadWorkspacePersonas: (workspaceKey) => personaRepository.loadAllForServer(workspaceKey),
  deliverDirectMessage: (interaction, payload) => interaction.user.send(payload),
  replyInfoEmbed,
};

function memoryExportSelectionValues(scope: MemoryExportScope): readonly string[] {
  return scope === "workspace" ? WORKSPACE_MEMORY_EXPORT_SELECTIONS : PERSONAL_MEMORY_EXPORT_SELECTIONS;
}

function memoryExportTypeLabelKey(scope: MemoryExportScope): string {
  return scope === "workspace"
    ? "commands.transfer.server_memories_label"
    : "commands.transfer.personal_memories_label";
}

/** Ranked so an exact nickname outranks a prefix, which outranks a mid-string match. */
function nicknameMatchRank(nickname: string, focusedValue: string): number {
  const lowerNickname = nickname.toLowerCase();
  if (lowerNickname === focusedValue) return 0;
  if (lowerNickname.startsWith(focusedValue)) return 1;
  return 2;
}

function resolveWorkspaceMemoryExportMode(
  selection: string,
  rawPersonaValue: string | null,
): WorkspaceMemoryExportMode | null {
  if (selection === "main") return { mode: "main" };
  if (selection === "all") return { mode: "all" };
  if (selection !== "persona") return null;

  const personaId = parsePersonaOptionId(rawPersonaValue);
  // The repository resolves the persona against the workspace and refuses an unknown one, so no read happens here.
  return personaId === null ? null : { mode: "persona", personaId };
}

async function resolvePersonalMemoryExportMode(
  dependencies: MemoryExportDependencies,
  workspaceKey: string,
  selection: string,
  rawPersonaValue: string | null,
): Promise<PersonalMemoryExportMode | null> {
  if (selection === "global") return { mode: "global" };
  if (selection === "all") return { mode: "all" };
  if (selection !== "persona") return null;

  if (parsePersonaOptionId(rawPersonaValue) === null) return null;
  const personas = await dependencies.loadWorkspacePersonas(workspaceKey);
  const lineageId = resolveSelectedPersona(personas, rawPersonaValue)?.persona_lineage_id;
  if (typeof lineageId !== "number" || !Number.isSafeInteger(lineageId) || lineageId < 0) return null;

  return { mode: "persona", personaLineageId: lineageId };
}

/**
 * The memory export operation shared by `/export memories` and `/export personal memories`, which differ only in
 * their authorization requirement, their scope vocabulary, and their destination key.
 */
export async function runMemoryExport(
  interaction: ChatInputCommandInteraction,
  locale: string,
  scope: MemoryExportScope,
  rawSelection: string | null,
  rawPersonaValue: string | null,
  overrides: Partial<MemoryExportDependencies> = {},
): Promise<void> {
  const dependencies: MemoryExportDependencies = { ...defaultDependencies, ...overrides };
  const selection = rawSelection ?? "";
  const workspaceKey = resolveWorkspaceTransferKey(interaction);
  const destinationKey = scope === "workspace" ? workspaceKey : interaction.user.id;
  const typeLabel = localizer(locale, memoryExportTypeLabelKey(scope));

  try {
    if (scope === "workspace" && !isWorkspaceTransferAuthorized(interaction)) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.no_permission_title",
        descriptionKey: "commands.data.export.no_permission_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Discord cannot make one option required by another option's value, so a Selected Persona scope without a
    // usable persona is refused here rather than left to a repository read that would report it as missing data.
    if (selection === "persona" && parsePersonaOptionId(rawPersonaValue) === null) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.transfer.memory_export_persona_required_title",
        descriptionKey: "commands.transfer.memory_export_persona_required_description",
        color: ColorCode.WARN,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!memoryExportSelectionValues(scope).includes(selection)) {
      // Reachable only through a stale registration, so the refusal is fail-closed rather than a default scope.
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "general.errors.invalid_option_title",
        descriptionKey: "general.errors.invalid_option_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Acknowledge before the memory read and the DM, both of which outlive Discord's three-second window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let exportResult: ExportResult;
    if (scope === "workspace") {
      const mode = resolveWorkspaceMemoryExportMode(selection, rawPersonaValue);
      if (!mode) {
        await dependencies.replyInfoEmbed(interaction, locale, {
          titleKey: "commands.transfer.memory_export_persona_invalid_title",
          descriptionKey: "commands.transfer.memory_export_persona_invalid_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      exportResult = await dependencies.exportWorkspaceMemories(destinationKey, mode);
    } else {
      // A personal export addresses the account, but its persona picker lists the current workspace's personas:
      // that is where a personal lineage is selected from, and the legacy personal leaf reads the same key.
      const mode = await resolvePersonalMemoryExportMode(dependencies, workspaceKey, selection, rawPersonaValue);
      if (!mode) {
        await dependencies.replyInfoEmbed(interaction, locale, {
          titleKey: "commands.transfer.memory_export_persona_invalid_title",
          descriptionKey: "commands.transfer.memory_export_persona_invalid_description",
          color: ColorCode.ERROR,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      exportResult = await dependencies.exportPersonalMemories(destinationKey, mode);
    }

    if (!exportResult.success || !exportResult.data) {
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.failed_title",
        descriptionKey: exportResult.error ?? "commands.data.export.failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(exportResult.data, null, 2), "utf-8"), {
      name: buildTransferExportFileName({
        scope,
        category: "memories",
        subject: resolveTransferExportSubject(scope, interaction),
      }),
    });

    try {
      await dependencies.deliverDirectMessage(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle(localizer(locale, "commands.data.export.dm_title"))
            .setDescription(localizer(locale, "commands.transfer.memory_export_dm_description", { type: typeLabel }))
            .setColor(ColorCode.INFO),
        ],
        files: [attachment],
      });

      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.success_title",
        descriptionKey: "commands.data.export.success_description",
        descriptionVars: { type: typeLabel },
        color: ColorCode.SUCCESS,
        flags: MessageFlags.Ephemeral,
      });
    } catch (dmError) {
      // The export read is non-destructive, so a closed DM needs only its own receipt and no compensating write.
      log.warn(`Failed to send memory export DM to user ${interaction.user.id}:`, dmError as Error);
      await dependencies.replyInfoEmbed(interaction, locale, {
        titleKey: "commands.data.export.dm_failed_title",
        descriptionKey: "commands.data.export.dm_failed_description",
        color: ColorCode.ERROR,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (error) {
    log.error(`Error executing the ${scope} memory export:`, error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: `${scope} memories export` },
    });

    await dependencies.replyInfoEmbed(interaction, locale, {
      titleKey: "general.errors.unknown_error_title",
      descriptionKey: "general.errors.unknown_error_description",
      color: ColorCode.ERROR,
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * The `persona` option's autocomplete, shared by both leaves. It keys on the same workspace the leaf does, so a
 * DM-backed workspace lists its own personas rather than answering nothing.
 */
export async function respondWithMemoryExportPersonas(
  interaction: AutocompleteInteraction,
  overrides: Partial<MemoryExportDependencies> = {},
): Promise<void> {
  const dependencies: MemoryExportDependencies = { ...defaultDependencies, ...overrides };

  try {
    const workspaceKey = interaction.guildId ?? interaction.user.id;
    const personas = await dependencies.loadWorkspacePersonas(workspaceKey);
    const focusedValue = (interaction.options.getFocused() ?? "").toLowerCase();
    const choices = personas
      .filter(
        (persona) =>
          typeof persona.persona_id === "number" &&
          (persona.persona_nickname ?? "").toLowerCase().includes(focusedValue),
      )
      .sort(
        (left, right) =>
          nicknameMatchRank(left.persona_nickname ?? "", focusedValue) -
          nicknameMatchRank(right.persona_nickname ?? "", focusedValue),
      )
      .slice(0, MEMORY_EXPORT_PERSONA_CHOICES_MAX)
      .map((persona) => ({
        name: safeSelectOptionText(persona.persona_nickname ?? "", 100),
        value: String(persona.persona_id),
      }));

    await interaction.respond(choices);
  } catch (error) {
    log.error("Memory export persona autocomplete failed:", error, {
      errorType: "CommandExecutionError",
      metadata: { commandName: "memories export autocomplete" },
    });
    try {
      await interaction.respond([]);
    } catch {
      // The dispatcher logs and answers on its own when the interaction can no longer be answered.
    }
  }
}
