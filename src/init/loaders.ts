import type { Client } from "discord.js";
import { log } from "@/utils/misc/logger";
import { initializeLocalizer } from "@/utils/text/localizer";
import eventHandler from "@/handlers/eventHandler";

/**
 * Initializes all application subsystems that must be ready before the bot
 * starts responding: tool registry, localizer, LLM caches, preset avatar cache,
 * and the event handler (which registers all Discord event listeners).
 *
 * Exits the process on critical failures (tool registry). All other failures
 * are non-critical, so the bot degrades gracefully without them.
 *
 */
export async function initLoaders(client: Client): Promise<void> {
  log.section("Initializing Tool Registry...");
  try {
    const { initializeTools } = await import("@/tools/toolInitializer");
    await initializeTools();
    log.success("Tool registry initialized successfully");
  } catch (error) {
    log.error("Failed to initialize tool registry", error as Error);
    process.exit(1);
  }

  log.section("Initializing Locales...");
  await initializeLocalizer();

  log.section("Initializing LLM Configuration Cache...");
  try {
    const { initializeLLMCache } = await import("@/utils/cache/llmCache");
    await initializeLLMCache();
    log.success("LLM configuration cache initialized successfully");
  } catch (error) {
    log.warn("Failed to initialize LLM cache (non-critical)", error);
  }

  log.section("Initializing OpenRouter Capability Cache...");
  try {
    const { initializeOpenRouterCapabilityCache } = await import("@/utils/cache/openrouterCapabilityCache");
    await initializeOpenRouterCapabilityCache();
    log.success("OpenRouter capability cache initialized successfully");
  } catch (error) {
    log.warn(
      "Failed to initialize OpenRouter capability cache (non-critical) - will fall back to database flags",
      error,
    );
  }

  log.section("Initializing OpenRouter Modality Catalogs...");
  try {
    const [
      { initializeOpenRouterVideoModelCache },
      { initializeOpenRouterImageModelCache },
      { initializeOpenRouterEmbeddingModelCache },
    ] = await Promise.all([
      import("@/utils/cache/openrouterVideoModelCache"),
      import("@/utils/cache/openrouterImageModelCache"),
      import("@/utils/cache/openrouterEmbeddingModelCache"),
    ]);
    await Promise.all([
      initializeOpenRouterVideoModelCache(),
      initializeOpenRouterImageModelCache(),
      initializeOpenRouterEmbeddingModelCache(),
    ]);
  } catch (error) {
    log.warn("Failed to initialize OpenRouter modality catalogs (non-critical)", error);
  }

  log.section("Initializing Preset Avatar Cache...");
  try {
    const { configRepository } = await import("@/utils/db/repositories");
    const { initializePresetAvatarCache } = await import("@/utils/image/avatarHelper");

    const presets = await configRepository.loadAllPresets();
    if (presets && presets.length > 0) {
      await initializePresetAvatarCache(presets);
      log.success("Preset avatar cache initialized successfully");
    } else {
      log.warn("No presets found to cache - avatar cache will be empty (non-critical)");
    }
  } catch (error) {
    log.warn("Failed to initialize preset avatar cache (non-critical)", error);
  }

  await eventHandler(client);
}
