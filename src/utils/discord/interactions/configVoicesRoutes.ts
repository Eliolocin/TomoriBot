import { MessageFlags, type ModalSubmitInteraction, type StringSelectMenuInteraction } from "discord.js";
import type { VoiceSampleRow } from "@/types/db/schema";
import type { PanelReceipt } from "@/types/discord/panel";
import type { ConfigPanelRoute } from "@/utils/discord/configPanelCatalog";
import { isConfigRouteAuthorized, type ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import {
  repaint,
  staleReceipt,
  type ConfigRouteDependencies,
  type ConfigScope,
} from "@/utils/discord/interactions/configRouteContext";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import {
  computeVoiceSampleFingerprint,
  decodeVoiceSampleOptionValue,
  CONFIG_VOICE_SAMPLE_PAGE_SIZE,
  voiceSampleAttachmentName,
  type ConfigVoiceSamplePreview,
  type ConfigVoicesView,
} from "@/utils/discord/ui/configVoicesPanel";
import { loadStoredVoiceSampleBuffer } from "@/utils/storage/voiceSampleStorage";
import {
  buildConfigModalFieldId,
  buildConfigTtsParametersModal,
  buildConfigVoiceSampleAddModal,
  CONFIG_TTS_CFG_WEIGHT_FIELD,
  CONFIG_TTS_EXAGGERATION_FIELD,
  CONFIG_TTS_TURBO_FIELD,
  CONFIG_VOICE_SAMPLE_FILE_FIELD,
  CONFIG_VOICE_SAMPLE_NAME_FIELD,
  CONFIG_VOICE_SAMPLE_REF_TEXT_FIELD,
} from "@/utils/discord/ui/configModals";
import { SPEECH_SAMPLE_MAX_MB } from "@/utils/speech/voiceSampleAddOperation";
import { validateVoiceSampleUpload, type VoiceSampleUpload } from "@/utils/speech/voiceSampleAddOperation";
import { log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export const CONFIG_VOICES_MODAL_OPEN_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "voice-sample-add-open",
  "tts-parameters-open",
]);

export const CONFIG_VOICES_MODAL_SUBMIT_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  "voice-sample-add-submit",
  "tts-parameters-submit",
]);

const CONFIG_VOICES_ROUTE_ACTIONS = new Set<ConfigPanelRoute["action"]>([
  ...CONFIG_VOICES_MODAL_SUBMIT_ACTIONS,
  "tts-turbo-set",
  "voice-sample-select",
  "voice-sample-page",
  "voice-sample-remove-view",
  "voice-sample-remove-confirm",
  "voice-sample-remove-cancel",
]);

const CHATTERBOX_DEFAULT_CFG_WEIGHT = 0.5;
const CHATTERBOX_DEFAULT_EXAGGERATION = 0.5;
const CHATTERBOX_DEFAULT_TURBO_ENABLED = true;
const CHATTERBOX_PARAMETER_MIN = 0;
const CHATTERBOX_PARAMETER_MAX = 2;

type VoicesReceipt = PanelReceipt;

function voiceSampleReceipt(
  locale: string,
  result: Awaited<ReturnType<ConfigRouteDependencies["addVoiceSample"]>>,
  sampleName: string,
): { tone: "success" | "error"; heading: string; detail: string } {
  switch (result.status) {
    case "invalid-format":
      return {
        tone: "error",
        heading: localizer(locale, "commands.config.panel.voices.add.format_error_title"),
        detail: localizer(locale, "commands.config.panel.voices.add.format_error_description"),
      };
    case "too-large":
      return {
        tone: "error",
        heading: localizer(locale, "commands.config.panel.voices.add.size_error_title"),
        detail: localizer(locale, "commands.config.panel.voices.add.size_error_description", {
          limit_mb: SPEECH_SAMPLE_MAX_MB,
        }),
      };
    case "too-long":
      return {
        tone: "error",
        heading: localizer(locale, "commands.config.panel.voices.add.duration_error_title"),
        detail: localizer(locale, "commands.config.panel.voices.add.duration_error_description", {
          limit_secs: result.limitSecs,
        }),
      };
    case "normalization-failed":
      return {
        tone: "error",
        heading: localizer(locale, "commands.config.panel.voices.add.normalization_error_title"),
        detail: localizer(locale, "commands.config.panel.voices.add.normalization_error_description"),
      };
    case "download-failed":
    case "write-failed":
      return {
        tone: "error",
        heading: localizer(locale, "general.errors.update_failed_title"),
        detail: localizer(locale, "general.errors.update_failed_description"),
      };
    case "success":
      return {
        tone: "success",
        heading: localizer(locale, "commands.config.panel.voices.add.success_title"),
        detail: localizer(locale, "commands.config.panel.voices.add.success_description", {
          name: sampleName,
          duration:
            result.durationSecs > 0 ? `${Math.floor(result.durationSecs)}s` : localizer(locale, "general.unknown"),
          ref_text_hint: result.refText
            ? localizer(locale, "commands.config.panel.voices.add.ref_text_provided")
            : localizer(locale, "commands.config.panel.voices.add.ref_text_missing"),
        }),
      };
  }
}

function modalTextValue(interaction: ModalSubmitInteraction, fieldId: string): string {
  if (!interaction.fields.fields.has(fieldId)) return "";
  return interaction.fields.getTextInputValue(fieldId).trim();
}

function speechConfigValues(config: Awaited<ReturnType<ConfigRouteDependencies["loadSpeechConfig"]>>): {
  cfgWeight: number;
  exaggeration: number;
  turboEnabled: boolean;
} {
  return {
    cfgWeight: config?.chatterbox_cfg_weight ?? CHATTERBOX_DEFAULT_CFG_WEIGHT,
    exaggeration: config?.chatterbox_exaggeration ?? CHATTERBOX_DEFAULT_EXAGGERATION,
    turboEnabled: config?.chatterbox_turbo_enabled ?? CHATTERBOX_DEFAULT_TURBO_ENABLED,
  };
}

function formatSpeechNumber(value: number): string {
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSpeechBoolean(locale: string, value: boolean): string {
  return localizer(
    locale,
    value
      ? "commands.config.panel.voices.parameters.enabled_label"
      : "commands.config.panel.voices.parameters.disabled_label",
  );
}

function speechParametersReceipt(
  locale: string,
  values: { cfgWeight: number; exaggeration: number; turboEnabled: boolean },
): VoicesReceipt {
  return {
    tone: "success",
    heading: localizer(locale, "commands.config.panel.voices.parameters.success_title"),
    detail: localizer(locale, "commands.config.panel.voices.parameters.success_description", {
      turbo: formatSpeechBoolean(locale, values.turboEnabled),
      cfg_weight: formatSpeechNumber(values.cfgWeight),
      exaggeration: formatSpeechNumber(values.exaggeration),
    }),
  };
}

function parseSpeechParameter(interaction: ModalSubmitInteraction, field: string, nonce: string): number | null {
  const raw = modalTextValue(interaction, buildConfigModalFieldId(field, nonce));
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < CHATTERBOX_PARAMETER_MIN || value > CHATTERBOX_PARAMETER_MAX) return null;
  return value;
}

function invalidSpeechParametersReceipt(locale: string, invalidFields: readonly string[]): VoicesReceipt {
  const labels = invalidFields.map((field) =>
    localizer(locale, `commands.config.panel.voices.parameters.${field}_label`),
  );
  return {
    tone: "error",
    heading: localizer(locale, "commands.config.panel.voices.parameters.invalid_input_title"),
    detail: localizer(locale, "commands.config.panel.voices.parameters.invalid_input_description", {
      settings: labels.join(" and "),
      min: CHATTERBOX_PARAMETER_MIN,
      max: CHATTERBOX_PARAMETER_MAX,
    }),
  };
}

function scopeServerId(scope: ConfigScope): number {
  return scope.internalServerId ?? scope.personas[0]?.server_id ?? 0;
}

interface LoadedVoicesPage {
  view: ConfigVoicesView;
  samples: VoiceSampleRow[];
}

async function loadFreshVoicesPage(
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  requestedStart: number,
  selectedIndex: number | null,
): Promise<LoadedVoicesPage> {
  const state = scope.personas[0];
  if (!state) throw new Error("Config voices route has no workspace state");

  const samples = await dependencies.loadVoiceSamples(scopeServerId(scope));
  const view = await dependencies.loadVoicesView(state, requestedStart, {
    loadSpeechConfig: dependencies.loadSpeechConfig,
    loadVoiceSamples: async () => samples,
  });
  view.selectedIndex = selectedIndex;
  return { view, samples };
}

function currentSampleAtIndex(
  samples: readonly VoiceSampleRow[],
  index: number,
  fingerprint: string,
): (VoiceSampleRow & { sample_id: number }) | null {
  const sample = samples[index];
  if (!sample || computeVoiceSampleFingerprint(sample) !== fingerprint || typeof sample.sample_id !== "number") {
    return null;
  }
  return { ...sample, sample_id: sample.sample_id };
}

function removalReceipt(locale: string, sampleName: string): VoicesReceipt {
  return {
    tone: "success",
    heading: localizer(locale, "commands.config.panel.voices.remove.success_title"),
    detail: localizer(locale, "commands.config.panel.voices.remove.success_description", { name: sampleName }),
  };
}

async function repaintVoices(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  scope: ConfigScope,
  dependencies: ConfigRouteDependencies,
  view: ConfigVoicesView,
  receipt?: VoicesReceipt,
): Promise<void> {
  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "models",
    page: "voices",
    selectedPersonaId: null,
    dependencies,
    voicesView: view,
    receipt,
  });
}

export type ConfigVoicesSubmitPreflight =
  | { status: "valid"; upload: VoiceSampleUpload; sampleName: string; refText: string | null }
  | { status: "invalid-format" | "too-large" | "missing" };

export function prepareConfigVoicesSubmit(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
): ConfigVoicesSubmitPreflight | null {
  if (route.action !== "voice-sample-add-submit" || !interaction.isModalSubmit()) return null;

  const modal = interaction as ModalSubmitInteraction;
  const fileFieldId = buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_FILE_FIELD, route.nonce);
  const attachment = dependencies.takeFileUpload(modal.id, fileFieldId);
  const sampleName = modalTextValue(modal, buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_NAME_FIELD, route.nonce));
  const refTextValue = modalTextValue(modal, buildConfigModalFieldId(CONFIG_VOICE_SAMPLE_REF_TEXT_FIELD, route.nonce));
  const refText = refTextValue || null;

  if (!attachment || !sampleName) return { status: "missing" };

  const upload: VoiceSampleUpload = {
    url: attachment.url,
    filename: attachment.filename,
    contentType: attachment.content_type,
    size: attachment.size,
  };
  const validation = validateVoiceSampleUpload(upload);
  if (validation !== "ok") return { status: validation };
  return { status: "valid", upload, sampleName, refText };
}

export function configVoicesPreflightReply(
  locale: string,
  status: Exclude<ConfigVoicesSubmitPreflight["status"], "valid">,
): { content: string; flags: MessageFlags.Ephemeral } {
  const receipt =
    status === "invalid-format"
      ? {
          heading: localizer(locale, "commands.config.panel.voices.add.format_error_title"),
          detail: localizer(locale, "commands.config.panel.voices.add.format_error_description"),
        }
      : status === "too-large"
        ? {
            heading: localizer(locale, "commands.config.panel.voices.add.size_error_title"),
            detail: localizer(locale, "commands.config.panel.voices.add.size_error_description", {
              limit_mb: SPEECH_SAMPLE_MAX_MB,
            }),
          }
        : {
            heading: localizer(locale, "general.errors.update_failed_title"),
            detail: localizer(locale, "general.errors.update_failed_description"),
          };
  return { content: `${receipt.heading}\n${receipt.detail}`, flags: MessageFlags.Ephemeral };
}

function genericUpdateFailedReceipt(locale: string): { tone: "error"; heading: string; detail: string } {
  return {
    tone: "error",
    heading: localizer(locale, "general.errors.update_failed_title"),
    detail: localizer(locale, "general.errors.update_failed_description"),
  };
}

export async function handleConfigVoicesModalOpen(
  interaction: GlobalRoutableInteraction,
  route: ConfigPanelRoute,
  dependencies: ConfigRouteDependencies,
  actor: ConfigActor,
): Promise<boolean> {
  if (!CONFIG_VOICES_MODAL_OPEN_ACTIONS.has(route.action)) return false;

  if (!isConfigRouteAuthorized(route, actor)) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.denied_detail"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const scope = await dependencies.resolveScope(interaction, false);
  if (!scope) {
    await interaction.reply({
      content: localizer(route.locale, "commands.config.panel.unavailable"),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (route.action === "tts-parameters-open") {
    try {
      const values = speechConfigValues(await dependencies.loadSpeechConfig(scopeServerId(scope)));
      await dependencies.showModal(
        interaction,
        buildConfigTtsParametersModal(
          route.locale,
          dependencies.createNonce(),
          values.cfgWeight,
          values.exaggeration,
          values.turboEnabled,
        ),
      );
    } catch (error) {
      await log.error("Config Chatterbox parameter modal failed", error, {
        errorType: "InteractionRouteError",
        metadata: { serverId: scopeServerId(scope) },
      });
      await interaction.reply({
        content: `${localizer(route.locale, "general.errors.update_failed_title")}\n${localizer(route.locale, "general.errors.update_failed_description")}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return true;
  }

  await dependencies.showModal(interaction, buildConfigVoiceSampleAddModal(route.locale, dependencies.createNonce()));
  return true;
}

export interface ConfigVoicesRouteContext {
  interaction: GlobalRoutableInteraction;
  route: ConfigPanelRoute;
  scope: ConfigScope;
  dependencies: ConfigRouteDependencies;
  preflight?: ConfigVoicesSubmitPreflight;
}

async function handleVoiceLibraryRoutes(context: ConfigVoicesRouteContext): Promise<boolean> {
  const { interaction, route, scope, dependencies } = context;
  const serverId = scopeServerId(scope);

  if (route.action === "voice-sample-page") {
    const loaded = await loadFreshVoicesPage(scope, dependencies, route.start, null);
    await repaintVoices(interaction, route, scope, dependencies, loaded.view);
    return true;
  }

  if (route.action === "voice-sample-select") {
    const selectedValue = (interaction as StringSelectMenuInteraction).values[0] ?? "";
    const selection = decodeVoiceSampleOptionValue(selectedValue);
    const requestedStart = selection
      ? Math.floor(selection.index / CONFIG_VOICE_SAMPLE_PAGE_SIZE) * CONFIG_VOICE_SAMPLE_PAGE_SIZE
      : 0;
    const loaded = await loadFreshVoicesPage(scope, dependencies, requestedStart, selection?.index ?? null);
    const sample = selection ? currentSampleAtIndex(loaded.samples, selection.index, selection.fp) : null;
    if (!selection || !sample) {
      await repaintVoices(
        interaction,
        route,
        scope,
        dependencies,
        { ...loaded.view, selectedIndex: null },
        staleReceipt(route.locale),
      );
      return true;
    }

    const attachmentName = voiceSampleAttachmentName(sample.sample_id);
    let buffer: Buffer | null = null;
    try {
      buffer = await loadStoredVoiceSampleBuffer(sample.file_path);
    } catch {
      buffer = null;
    }
    const preview: ConfigVoiceSamplePreview = {
      sampleId: sample.sample_id,
      fingerprint: selection.fp,
      attachmentName,
      ...(buffer ? { buffer } : {}),
      unavailable: !buffer,
    };
    await repaintVoices(interaction, route, scope, dependencies, {
      ...loaded.view,
      selectedIndex: selection.index,
      preview,
    });
    return true;
  }

  if (route.action === "voice-sample-remove-cancel") {
    const loaded = await loadFreshVoicesPage(scope, dependencies, 0, null);
    await repaintVoices(interaction, route, scope, dependencies, loaded.view);
    return true;
  }

  if (route.action === "voice-sample-remove-view") {
    const requestedStart = Math.floor(route.index / CONFIG_VOICE_SAMPLE_PAGE_SIZE) * CONFIG_VOICE_SAMPLE_PAGE_SIZE;
    const loaded = await loadFreshVoicesPage(scope, dependencies, requestedStart, route.index);
    const sample = currentSampleAtIndex(loaded.samples, route.index, route.fp);
    if (!sample) {
      await repaintVoices(
        interaction,
        route,
        scope,
        dependencies,
        { ...loaded.view, selectedIndex: null },
        staleReceipt(route.locale),
      );
      return true;
    }

    const refCount = await dependencies.countVoiceSampleRefs(serverId, sample.sample_id as number);
    await repaintVoices(interaction, route, scope, dependencies, {
      ...loaded.view,
      selectedIndex: route.index,
      removeConfirm: {
        index: route.index,
        fp: route.fp,
        refCount,
        nonce: dependencies.createNonce(),
      },
    });
    return true;
  }

  if (route.action === "voice-sample-remove-confirm") {
    const requestedStart = Math.floor(route.index / CONFIG_VOICE_SAMPLE_PAGE_SIZE) * CONFIG_VOICE_SAMPLE_PAGE_SIZE;
    const loaded = await loadFreshVoicesPage(scope, dependencies, requestedStart, route.index);
    const sample = currentSampleAtIndex(loaded.samples, route.index, route.fp);
    if (!sample) {
      await repaintVoices(
        interaction,
        route,
        scope,
        dependencies,
        { ...loaded.view, selectedIndex: null },
        staleReceipt(route.locale),
      );
      return true;
    }

    let resultReceipt: VoicesReceipt;
    try {
      await dependencies.removeVoiceSample({
        serverId,
        serverDiscId: scope.serverDiscId,
        sampleId: sample.sample_id as number,
        filePath: sample.file_path,
      });
      resultReceipt = removalReceipt(route.locale, sample.name);
    } catch (error) {
      await log.error("Config voice sample removal failed", error, {
        errorType: "InteractionRouteError",
        metadata: { serverId, sampleId: sample.sample_id },
      });
      resultReceipt = genericUpdateFailedReceipt(route.locale);
    }

    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "models",
      page: "voices",
      selectedPersonaId: null,
      dependencies,
      voiceSamplePageStart: requestedStart,
      receipt: resultReceipt,
    });
    return true;
  }

  return false;
}

export async function handleConfigVoicesRoutes(context: ConfigVoicesRouteContext): Promise<boolean> {
  const { interaction, route, scope, dependencies, preflight } = context;
  if (!CONFIG_VOICES_ROUTE_ACTIONS.has(route.action)) return false;
  if (CONFIG_VOICES_MODAL_SUBMIT_ACTIONS.has(route.action) && !interaction.isModalSubmit()) return true;

  if (route.action === "voice-sample-add-submit" && (!preflight || preflight.status !== "valid")) {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "models",
      page: "voices",
      selectedPersonaId: null,
      dependencies,
      receipt: genericUpdateFailedReceipt(route.locale),
    });
    return true;
  }

  if (route.action === "voice-sample-add-submit") {
    let resultReceipt: VoicesReceipt;
    try {
      const result = await dependencies.addVoiceSample(
        {
          serverId: scopeServerId(scope),
          upload: (preflight as Extract<ConfigVoicesSubmitPreflight, { status: "valid" }>).upload,
          sampleName: (preflight as Extract<ConfigVoicesSubmitPreflight, { status: "valid" }>).sampleName,
          refText: (preflight as Extract<ConfigVoicesSubmitPreflight, { status: "valid" }>).refText,
        },
        dependencies.voiceSampleAddDependencies,
      );
      resultReceipt = voiceSampleReceipt(
        route.locale,
        result,
        (preflight as Extract<ConfigVoicesSubmitPreflight, { status: "valid" }>).sampleName,
      );
    } catch (error) {
      await log.error("Config voice sample add operation failed", error, {
        errorType: "InteractionRouteError",
        metadata: { serverId: scopeServerId(scope) },
      });
      resultReceipt = genericUpdateFailedReceipt(route.locale);
    }

    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "models",
      page: "voices",
      selectedPersonaId: null,
      dependencies,
      receipt: resultReceipt,
    });
    return true;
  }

  if (
    route.action === "voice-sample-select" ||
    route.action === "voice-sample-page" ||
    route.action === "voice-sample-remove-view" ||
    route.action === "voice-sample-remove-confirm" ||
    route.action === "voice-sample-remove-cancel"
  ) {
    return handleVoiceLibraryRoutes(context);
  }

  let values: { cfgWeight: number; exaggeration: number; turboEnabled: boolean } | null = null;
  if (route.action === "tts-parameters-submit") {
    const modal = interaction as ModalSubmitInteraction;
    const cfgWeight = parseSpeechParameter(modal, CONFIG_TTS_CFG_WEIGHT_FIELD, route.nonce);
    const exaggeration = parseSpeechParameter(modal, CONFIG_TTS_EXAGGERATION_FIELD, route.nonce);
    const turboValue = dependencies.takeSelectValue(
      modal.id,
      buildConfigModalFieldId(CONFIG_TTS_TURBO_FIELD, route.nonce),
    );
    const invalidFields = [
      ...(cfgWeight === null ? ["cfg_weight"] : []),
      ...(exaggeration === null ? ["exaggeration"] : []),
    ];
    if (turboValue !== "off" && turboValue !== "on") {
      invalidFields.push("turbo");
    }
    if (invalidFields.length > 0) {
      await repaint(interaction, {
        locale: route.locale,
        scope,
        category: "models",
        page: "voices",
        selectedPersonaId: null,
        dependencies,
        receipt:
          invalidFields.length === 1 && invalidFields[0] === "turbo"
            ? genericUpdateFailedReceipt(route.locale)
            : invalidSpeechParametersReceipt(
                route.locale,
                invalidFields.filter((field) => field !== "turbo"),
              ),
      });
      return true;
    }
    values = {
      cfgWeight: cfgWeight as number,
      exaggeration: exaggeration as number,
      turboEnabled: turboValue === "on",
    };
  } else if (route.action === "tts-turbo-set") {
    try {
      const current = speechConfigValues(await dependencies.loadSpeechConfig(scopeServerId(scope)));
      values = { ...current, turboEnabled: route.enabled };
    } catch (error) {
      await log.error("Config Chatterbox turbo read failed", error, {
        errorType: "InteractionRouteError",
        metadata: { serverId: scopeServerId(scope) },
      });
    }
  }

  if (!values) {
    await repaint(interaction, {
      locale: route.locale,
      scope,
      category: "models",
      page: "voices",
      selectedPersonaId: null,
      dependencies,
      receipt: genericUpdateFailedReceipt(route.locale),
    });
    return true;
  }

  let resultReceipt: VoicesReceipt;
  try {
    const updated = await dependencies.updateSpeechConfig(scopeServerId(scope), {
      chatterbox_cfg_weight: values.cfgWeight,
      chatterbox_exaggeration: values.exaggeration,
      chatterbox_turbo_enabled: values.turboEnabled,
    });
    if (!updated) {
      resultReceipt = genericUpdateFailedReceipt(route.locale);
    } else {
      dependencies.invalidateSpeechConfigCache(scope.serverDiscId);
      resultReceipt = speechParametersReceipt(route.locale, values);
    }
  } catch (error) {
    await log.error("Config Chatterbox parameter update failed", error, {
      errorType: "InteractionRouteError",
      metadata: { serverId: scopeServerId(scope) },
    });
    resultReceipt = genericUpdateFailedReceipt(route.locale);
  }

  await repaint(interaction, {
    locale: route.locale,
    scope,
    category: "models",
    page: "voices",
    selectedPersonaId: null,
    dependencies,
    receipt: resultReceipt,
  });
  return true;
}
