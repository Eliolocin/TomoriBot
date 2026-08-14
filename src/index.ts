import { config } from "dotenv";
import { resolveEnvironment } from "@/types/config";
import { startHealthServer } from "@/init/healthServer";
import { registerHeapSnapshotHandler } from "@/init/heapSnapshot";
import { loadSecrets } from "@/init/secrets";
import { initStartupBackup } from "@/init/backup";
import { createDiscordClient, resolvePresenceIntentEnabled } from "@/init/discord";
import { initDatabase } from "@/init/database";
import { initLoaders } from "@/init/loaders";
import { initBridges } from "@/init/bridges";
import { initTimers } from "@/init/timers";
import { initMediaProcessing } from "@/init/media";
import { log } from "@/utils/misc/logger";

/**
 * Detects Discord's "privileged intent not approved" rejection.
 *
 * When the GuildPresences intent is requested but not approved, the gateway
 * closes the connection with code 4014 and discord.js rejects login with a
 * `DisallowedIntents` error. We match on the error code and message so the
 * failure can be reported as an actionable misconfiguration rather than a
 * silent, never-connected process.
 *
 * @returns true if the failure is a disallowed/privileged intent rejection
 */
function isDisallowedIntentsError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === "DisallowedIntents") return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("disallowed intents") || message.includes("privileged intent");
}

config({ quiet: true });

const environment = resolveEnvironment();

await initStartupBackup(environment);

// Bind to PORT immediately so Cloud Run's startup probe passes before the rest of init runs
if (environment === "production") {
  const healthPort = Number.parseInt(process.env.PORT ?? "8080", 10);
  startHealthServer(healthPort);
}

await loadSecrets(environment);

registerHeapSnapshotHandler();

initMediaProcessing();

// Probe Discord for Presence Intent approval (or honor an explicit override) before
// building the client, so we request the privileged intent only when it is actually
// enabled, so self-resolving the moment Discord grants approval, with no failed
// gateway handshake and no manual env change.
const includePresences = await resolvePresenceIntentEnabled(environment);
const client = createDiscordClient(includePresences);

await initDatabase(environment);

await initLoaders(client);

await initBridges(client);

initTimers(client);

// Login, so triggers clientReady which starts all deferred timers.
// Awaited inside a try/catch as a defensive net: resolvePresenceIntentEnabled
// already prevents requesting an unapproved privileged intent, so a
// DisallowedIntents rejection here is a rare edge (e.g. the Presence Intent was
// revoked between the approval probe and login). We exit loudly rather than
// re-wiring the client in place (which would duplicate one-time init like the
// Matrix bridge and quota-cleanup interval); the probe on the next restart
// self-heals by booting without the privileged intent.
try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (error) {
  if (isDisallowedIntentsError(error)) {
    log.error(
      "Discord rejected login: a requested privileged intent is not approved for this bot. " +
        "This is unexpected because approval is probed before connecting — check whether the " +
        "Presence Intent was revoked. Restarting will re-probe and boot without the intent " +
        "(presence context degrades gracefully).",
      error as Error,
    );
    process.exit(1);
  }
  log.error("Discord login failed", error as Error);
  process.exit(1);
}
