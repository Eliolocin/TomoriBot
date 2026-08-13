/**
 * OpenRouter Catalog Refresher
 * Keeps the four OpenRouter model catalogs from serving a boot-time snapshot for the life
 * of a deployment.
 */

import { refreshOpenRouterCapabilityCacheIfStale } from "@/utils/cache/openrouterCapabilityCache";
import { getOpenRouterCatalogTtlMs } from "@/utils/cache/openrouterCatalog";
import { refreshOpenRouterEmbeddingModelCacheIfStale } from "@/utils/cache/openrouterEmbeddingModelCache";
import { refreshOpenRouterImageModelCacheIfStale } from "@/utils/cache/openrouterImageModelCache";
import { refreshOpenRouterVideoModelCacheIfStale } from "@/utils/cache/openrouterVideoModelCache";
import { log } from "@/utils/misc/logger";

/**
 * Registration reaches the network on a cache miss, so it self-heals without this timer.
 * The synchronous readers cannot: pricing, context limits, tokenizer, and supported
 * parameters are consulted per turn and would keep answering from the boot snapshot for
 * weeks. This exists for them.
 */
export class OpenRouterCatalogRefresher {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.isRunning) {
      log.warn("OpenRouter catalog refresher is already running");
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.intervalMs);

    // Node keeps the process alive for pending timers; a metadata refresh is never a
    // reason to delay shutdown.
    this.intervalId.unref?.();
  }

  public stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      // Each catalog applies its own staleness and cooldown gates, so a tick that finds
      // everything fresh performs no network work.
      await Promise.all([
        refreshOpenRouterCapabilityCacheIfStale(),
        refreshOpenRouterEmbeddingModelCacheIfStale(),
        refreshOpenRouterImageModelCacheIfStale(),
        refreshOpenRouterVideoModelCacheIfStale(),
      ]);
    } catch (error) {
      log.error("Error during scheduled OpenRouter catalog refresh:", error);
    }
  }

  public getStatus(): { isRunning: boolean; intervalMs: number } {
    return { isRunning: this.isRunning, intervalMs: this.intervalMs };
  }
}

let refresherInstance: OpenRouterCatalogRefresher | null = null;

export function initializeOpenRouterCatalogRefresher(intervalMs?: number): void {
  if (refresherInstance) {
    log.warn("OpenRouter catalog refresher already initialized");
    return;
  }

  // Ticking well inside the TTL keeps the worst-case staleness near the TTL itself rather
  // than near twice it, which a tick period equal to the TTL would produce.
  const resolved = intervalMs ?? Math.max(60_000, Math.floor(getOpenRouterCatalogTtlMs() / 4));

  refresherInstance = new OpenRouterCatalogRefresher(resolved);
  refresherInstance.start();
}

export function stopOpenRouterCatalogRefresher(): void {
  if (refresherInstance) {
    refresherInstance.stop();
    refresherInstance = null;
  }
}
