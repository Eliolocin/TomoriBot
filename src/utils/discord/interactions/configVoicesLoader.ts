import type { TomoriState, VoiceSampleRow } from "@/types/db/schema";
import { configRepository } from "@/utils/db/repositories";
import { loadVoiceSamples } from "@/utils/db/repositories/SpeechRepository";
import { CONFIG_VOICE_SAMPLE_PAGE_SIZE, type ConfigVoicesView } from "@/utils/discord/ui/configVoicesPanel";

export interface ConfigVoicesLoaderDependencies {
  loadSpeechConfig: (serverId: number) => ReturnType<typeof configRepository.getSpeechConfig>;
  loadVoiceSamples: (serverId: number) => Promise<VoiceSampleRow[]>;
}

const defaultDependencies: ConfigVoicesLoaderDependencies = {
  loadSpeechConfig: (serverId) => configRepository.getSpeechConfig(serverId),
  loadVoiceSamples,
};

function normalizeVoiceSampleStart(requestedStart: number, totalSampleCount: number): number {
  const safeStart = Number.isSafeInteger(requestedStart) ? requestedStart : 0;
  const pageIndex = Math.max(0, Math.floor(safeStart / CONFIG_VOICE_SAMPLE_PAGE_SIZE));
  const maxPageIndex = Math.max(0, Math.ceil(totalSampleCount / CONFIG_VOICE_SAMPLE_PAGE_SIZE) - 1);
  return Math.min(pageIndex, maxPageIndex) * CONFIG_VOICE_SAMPLE_PAGE_SIZE;
}

export async function loadConfigVoicesView(
  state: TomoriState,
  requestedStart = 0,
  deps: ConfigVoicesLoaderDependencies = defaultDependencies,
): Promise<ConfigVoicesView> {
  const [speechConfig, allSamples] = await Promise.all([
    deps.loadSpeechConfig(state.server_id),
    deps.loadVoiceSamples(state.server_id),
  ]);
  const start = normalizeVoiceSampleStart(requestedStart, allSamples.length);
  return {
    turboEnabled: speechConfig?.chatterbox_turbo_enabled ?? state.config.chatterbox_turbo_enabled ?? true,
    cfgWeight: speechConfig?.chatterbox_cfg_weight ?? state.config.chatterbox_cfg_weight ?? 0.5,
    exaggeration: speechConfig?.chatterbox_exaggeration ?? state.config.chatterbox_exaggeration ?? 0.5,
    samples: allSamples.slice(start, start + CONFIG_VOICE_SAMPLE_PAGE_SIZE),
    totalSampleCount: allSamples.length,
    start,
    selectedIndex: null,
  };
}
