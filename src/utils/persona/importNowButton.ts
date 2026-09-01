/**
 * "Import Now" button wiring for `/persona generate` and `/persona create`
 * success messages.
 *
 * The success message is a public Components V2 container. A server manager can
 * press "Import Now" to import the freshly generated persona as an alter without
 * re-uploading the image via `/persona import`. Because the message is public,
 * the manager-only restriction is enforced on click (not by visibility), and the
 * button is driven by a per-message collector; matching the established pattern
 * in `expandableEmbedNotice.ts` (this codebase has no global button router).
 */

import {
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  ComponentType,
  EmbedBuilder,
  type Guild,
  type Message,
  MessageFlags,
  type ModalSubmitInteraction,
} from "discord.js";
import {
  buildPersonaResultContainer,
  type PersonaResultButtonOptions,
  type PersonaResultContainerOptions,
} from "@/utils/discord/ui/statusComponents";
import { ColorCode, log } from "@/utils/misc/logger";
import { importAlterPreset } from "@/utils/persona/importAlterPreset";
import { localizer } from "@/utils/text/localizer";
import type { PresetExportData } from "@/types/preset/presetExport";

/** Custom ID for the Import Now button (unique across the app). */
const IMPORT_NOW_CUSTOM_ID = "persona_import_now";

/**
 * Collector lifetime for the Import Now button. Capped under Discord's 15-minute
 * interaction-token window so the timeout teardown can still edit the original
 * reply. Configurable via env.
 */
const IMPORT_NOW_BUTTON_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.PERSONA_IMPORT_NOW_BUTTON_TIMEOUT_MS ?? "", 10);
  // Default to 14 minutes; clamp to a sane range below the 15-minute token expiry.
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 14 * 60 * 1000) : 14 * 60 * 1000;
})();

/** Visual state of the Import Now button. */
type ImportNowButtonState = "active" | "done" | "expired";

/**
 * Builds the Import Now button config for a given state. The label is a locale
 * key resolved later by {@link buildPersonaResultContainer}, so no locale is needed here.
 *
 */
export function importNowButton(state: ImportNowButtonState): PersonaResultButtonOptions {
  if (state === "done") {
    return {
      customId: IMPORT_NOW_CUSTOM_ID,
      labelKey: "commands.persona.import_now.imported",
      style: ButtonStyle.Secondary,
      disabled: true,
    };
  }
  return {
    customId: IMPORT_NOW_CUSTOM_ID,
    labelKey: "commands.persona.import_now.button",
    style: ButtonStyle.Secondary,
    disabled: state === "expired",
  };
}

/**
 * Parameters for {@link attachImportNowCollector}.
 */
export interface ImportNowCollectorParams {
  /** The already-sent public success message carrying the Import Now button. */
  message: Message;
  /** Discord client (for avatar fallback resolution inside the import core). */
  client: Client;
  /** Guild the import targets (Import Now is only attached in guild contexts). */
  guild: Guild | null;
  /** Server scope ID the persona belongs to. */
  serverDiscId: string;
  /** Locale for all button/confirmation strings. */
  locale: string;
  /** Validated preset payload to import (already in memory from generation). */
  presetData: PresetExportData;
  /** Persona image (PNG) used as the alter avatar. */
  avatarImageBuffer: Buffer | null;
  /** Container layout/content used to re-render the message on state changes. */
  containerOptions: Omit<PersonaResultContainerOptions, "button">;
  /** Source interaction, used to disable the button if the collector times out. */
  sourceInteraction: ModalSubmitInteraction | ChatInputCommandInteraction;
}

/**
 * Maps an {@link importAlterPreset} failure reason to a localized error embed.
 *
 * @param result - The failed import result.
 * @returns An EmbedBuilder describing the failure.
 */
function buildImportErrorEmbed(
  locale: string,
  result: Exclude<Awaited<ReturnType<typeof importAlterPreset>>, { ok: true }>,
): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(ColorCode.ERROR);
  switch (result.reason) {
    case "limit_reached":
      return embed.setTitle(localizer(locale, "commands.persona.import.alter_limit_title")).setDescription(
        localizer(locale, "commands.persona.import.alter_limit_description", {
          current: result.current,
          max: result.max,
        }),
      );
    case "name_conflict":
      return embed.setTitle(localizer(locale, "commands.persona.import.alter_name_conflict_title")).setDescription(
        localizer(locale, "commands.persona.import.alter_name_conflict_description", {
          name: result.name,
        }),
      );
    case "no_main_persona":
      return embed
        .setTitle(localizer(locale, "general.errors.tomori_not_setup_title"))
        .setDescription(localizer(locale, "general.errors.tomori_not_setup_description"));
    case "config_failed":
      return embed
        .setTitle(localizer(locale, "general.errors.update_failed_title"))
        .setDescription(localizer(locale, "general.errors.update_failed_description"));
    default:
      return embed
        .setTitle(localizer(locale, "general.errors.unknown_error_title"))
        .setDescription(localizer(locale, "general.errors.unknown_error_description"));
  }
}

/**
 * Attaches the Import Now click handler to a persona-result message.
 *
 * On click: enforces ManageGuild, then runs the shared {@link importAlterPreset}
 * core (always as an alter, identity preserved), disables the button on success,
 * and replies ephemerally with the outcome. The button is one-shot: a successful
 * import stops the collector; a failure re-arms it for another attempt.
 *
 */
export function attachImportNowCollector(params: ImportNowCollectorParams): void {
  const {
    message,
    client,
    guild,
    serverDiscId,
    locale,
    presetData,
    avatarImageBuffer,
    containerOptions,
    sourceInteraction,
  } = params;

  // Guards against a double-click race while an import is in flight or after success.
  let consumed = false;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: IMPORT_NOW_BUTTON_TIMEOUT_MS,
    filter: (interaction) => interaction.customId === IMPORT_NOW_CUSTOM_ID && !interaction.user.bot,
  });

  collector.on("collect", async (interaction: ButtonInteraction) => {
    // Manager-only gate. The message is public, so the restriction must be
    //    enforced here rather than relying on who can see the button.
    const hasPermission = interaction.memberPermissions?.has("ManageGuild") ?? false;
    if (!hasPermission) {
      await interaction
        .reply({
          embeds: [
            new EmbedBuilder()
              .setColor(ColorCode.ERROR)
              .setTitle(localizer(locale, "commands.persona.import.no_permission_title"))
              .setDescription(localizer(locale, "commands.persona.import.no_permission_description")),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch((error: unknown) => log.warn("Import Now: failed to send permission refusal", error as Error));
      return;
    }

    if (consumed) {
      await interaction
        .reply({
          embeds: [
            new EmbedBuilder()
              .setColor(ColorCode.WARN)
              .setTitle(localizer(locale, "commands.persona.import_now.already_imported_title"))
              .setDescription(localizer(locale, "commands.persona.import_now.already_imported_description")),
          ],
          flags: MessageFlags.Ephemeral,
        })
        .catch((error: unknown) => log.warn("Import Now: failed to send already-imported notice", error as Error));
      return;
    }
    consumed = true;

    // Acknowledge the click; the import (DB + storage) may exceed the 3s window.
    try {
      await interaction.deferUpdate();
    } catch (error) {
      consumed = false;
      log.warn("Import Now: failed to defer button update", error as Error);
      return;
    }

    // Run the shared alter-import core (always alter, identity preserved).
    const result = await importAlterPreset({
      client,
      guild,
      serverDiscId,
      presetData,
      identityMode: "preserve",
      avatarImageBuffer,
    });

    if (!result.ok) {
      consumed = false;
      await interaction
        .followUp({ embeds: [buildImportErrorEmbed(locale, result)], flags: MessageFlags.Ephemeral })
        .catch((error: unknown) => log.warn("Import Now: failed to send error follow-up", error as Error));
      return;
    }

    try {
      await interaction.editReply({
        components: buildPersonaResultContainer({ ...containerOptions, button: importNowButton("done") }),
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      log.warn("Import Now: failed to disable button after import", error as Error);
    }

    // Confirm privately to the manager who imported.
    await interaction
      .followUp({
        embeds: [
          new EmbedBuilder()
            .setColor(result.hasNoTriggers || result.usedMainAvatarFallback ? ColorCode.WARN : ColorCode.SUCCESS)
            .setTitle(localizer(locale, "commands.persona.import.alter_success_title"))
            .setDescription(
              localizer(locale, "commands.persona.import.alter_success_confirmation", {
                nickname: result.nickname,
                trigger_count: result.uniqueTriggerCount,
              }),
            ),
        ],
        flags: MessageFlags.Ephemeral,
      })
      .catch((error: unknown) => log.warn("Import Now: failed to send success follow-up", error as Error));

    collector.stop("imported");
  });

  collector.on("end", async (_collected, reason) => {
    // Success already disabled the button; nothing to do.
    if (reason === "imported") return;

    // Best-effort: grey out the button on timeout. Edits the original reply via
    // the source interaction token, which is still valid given the <15m timeout.
    try {
      await sourceInteraction.editReply({
        components: buildPersonaResultContainer({ ...containerOptions, button: importNowButton("expired") }),
        flags: MessageFlags.IsComponentsV2,
      });
    } catch (error) {
      log.warn("Import Now: failed to disable button after collector end", error as Error);
    }
  });
}
