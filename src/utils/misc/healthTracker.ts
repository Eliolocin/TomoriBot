import type { Client } from "discord.js";
import { log } from "./logger";

/**
 * Health tracking system for monitoring bot connectivity.
 *
 * Tracks Discord readiness and WebSocket heartbeat only. **It does not observe the event loop**,
 * despite what the health endpoint's name suggests; `eventLoopMonitor` does that and reports
 * separately.
 */
class HealthTracker {
  /**
   * Timestamp of the last Discord event received (any event type)
   */
  private lastActivityTimestamp: number = Date.now();

  /**
   * Discord client instance for checking WebSocket status
   */
  private client: Client | null = null;

  /**
   * Maximum time (in milliseconds) without activity before considering unhealthy
   * Default: 2 minutes
   * NOTE: Currently unused - see "Lonely Bot" problem comment in getHealthStatus()
   */
  // private readonly activityTimeout: number = 2 * 60 * 1000;

  /**
   * Maximum WebSocket ping latency (in milliseconds) before considering unhealthy
   * Default: 5 seconds
   */
  private readonly maxPingLatency: number = 5000;

  /**
   * Initialize the health tracker with a Discord client
   */
  initialize(client: Client): void {
    this.client = client;
    this.lastActivityTimestamp = Date.now();
    log.info("Health tracker initialized");
  }

  /**
   * Record that a Discord event was processed
   * Call this from event handlers to update activity timestamp
   */
  recordActivity(): void {
    this.lastActivityTimestamp = Date.now();
  }

  getHealthStatus(): HealthStatus {
    const now = Date.now();
    const timeSinceLastActivity = now - this.lastActivityTimestamp;

    if (!this.client) {
      return {
        healthy: false,
        reason: "Client not initialized",
        details: {
          clientReady: false,
          timeSinceLastActivity,
          websocketPing: null,
        },
      };
    }

    const isClientReady = this.client.isReady();
    if (!isClientReady) {
      return {
        healthy: false,
        reason: "Discord client not ready",
        details: {
          clientReady: false,
          timeSinceLastActivity,
          websocketPing: null,
        },
      };
    }

    // Check WebSocket ping (measures roundtrip latency to Discord)
    const websocketPing = this.client.ws.ping;
    if (websocketPing < 0 || websocketPing > this.maxPingLatency) {
      return {
        healthy: false,
        reason: `WebSocket ping unhealthy: ${websocketPing}ms`,
        details: {
          clientReady: true,
          timeSinceLastActivity,
          websocketPing,
        },
      };
    }

    // Activity timeout check (DISABLED)
    // Kept off to prevent false positives during quiet hours. The "Lonely Bot" problem: during
    // periods of low activity (e.g. 3 AM) no Discord events arrive, so the bot reports "unhealthy"
    // while perfectly functional, which on a platform that restarts unhealthy containers becomes a
    // restart loop.
    //
    // An earlier version of this comment justified the omission by claiming that "if the event loop
    // were frozen, the HTTP health check request itself would timeout". **That is false**, and it
    // is why a starved main thread went unnoticed for hours: a loop that yields between chunks of
    // work still answers a short health probe in milliseconds while multi-step handlers behind it
    // make no progress. Liveness and progress are different properties. `eventLoopMonitor` measures
    // the second one and exposes it on the same endpoint.
    //
    // If you want to re-enable this check, ensure you're listening to 'raw' events via
    // client.on('raw', () => healthTracker.recordActivity()) to catch all Discord activity.
    /*
		if (timeSinceLastActivity > this.activityTimeout) {
			return {
				healthy: false,
				reason: `No Discord activity for ${Math.floor(timeSinceLastActivity / 1000)}s`,
				details: {
					clientReady: true,
					timeSinceLastActivity,
					websocketPing,
				},
			};
		}
		*/

    return {
      healthy: true,
      reason: "All systems operational",
      details: {
        clientReady: true,
        timeSinceLastActivity,
        websocketPing,
      },
    };
  }

  getTimeSinceLastActivity(): number {
    return Date.now() - this.lastActivityTimestamp;
  }

  /**
   * Get WebSocket ping latency in milliseconds
   */
  getWebSocketPing(): number {
    return this.client?.ws.ping ?? -1;
  }
}

/**
 * Health status result structure
 */
interface HealthStatus {
  /**
   * Whether the bot is considered healthy
   */
  healthy: boolean;

  /**
   * Human-readable reason for the health status
   */
  reason: string;

  /**
   * Detailed metrics for debugging
   */
  details: {
    /**
     * Whether Discord client is in ready state
     */
    clientReady: boolean;

    /**
     * Time in milliseconds since last Discord event
     */
    timeSinceLastActivity: number;

    /**
     * WebSocket ping latency in milliseconds (null if not available)
     */
    websocketPing: number | null;
  };
}

/**
 * Singleton instance for global health tracking
 */
export const healthTracker = new HealthTracker();
