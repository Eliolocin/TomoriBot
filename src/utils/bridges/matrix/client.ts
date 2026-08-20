import { createRequire } from "node:module";
import type * as MatrixAppserviceBridge from "matrix-appservice-bridge";
import type { Request as BridgeRequest, WeakEvent } from "matrix-appservice-bridge";
import type { Client } from "discord.js";
import { localizer } from "@/utils/text/localizer";
import { log } from "@/utils/misc/logger";
import { handleMatrixEvent } from "./events";
import { getMatrixBridge, setMatrixBridge } from "./state";

const _require = createRequire(import.meta.url);
const { Bridge, AppServiceRegistration } = _require("matrix-appservice-bridge") as typeof MatrixAppserviceBridge;

export async function initializeMatrixClient(discordClient: Client): Promise<void> {
  const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
  const asToken = process.env.MATRIX_ACCESS_TOKEN;
  const hsToken = process.env.MATRIX_HS_TOKEN;
  const botUserId = process.env.MATRIX_BOT_USER_ID;
  const serverName = process.env.MATRIX_SERVER_NAME;

  if (!homeserverUrl || !asToken || !hsToken || !botUserId || !serverName) {
    log.info("Matrix bridge: credentials not configured - bridge disabled");
    return;
  }

  const port = Number.parseInt(process.env.MATRIX_APPSERVICE_PORT || "9993", 10);
  const registrationUrl = resolveRegistrationUrl(port);

  try {
    const registration = AppServiceRegistration.fromObject({
      id: "tomoribot-appservice",
      hs_token: hsToken,
      as_token: asToken,
      url: registrationUrl,
      sender_localpart: "tomoribot",
      namespaces: {
        users: [{ exclusive: true, regex: `@_tomori_.*:${serverName}` }],
        aliases: [],
        rooms: [],
      },
      rate_limited: false,
    });

    const bridge = new Bridge({
      homeserverUrl,
      domain: serverName,
      registration,
      disableStores: true,
      disableContext: true,
      controller: {
        onEvent: (request: BridgeRequest<WeakEvent>): void => {
          void handleMatrixEvent(request, discordClient, botUserId).catch((error) => {
            log.warn("Matrix bridge: uncaught error in event handler", error);
          });
        },
        onLog: (_text: string, isError: boolean): void => {
          if (isError) {
            log.warn(`[matrix-appservice-bridge] ${_text}`);
          }
        },
      },
    });

    setMatrixBridge(bridge);
    await bridge.run(port);
    log.success(
      `Matrix appservice initialized - ${botUserId} @ ${homeserverUrl} ` +
        `(listening on port ${port}, callback ${registrationUrl})`,
    );
  } catch (error) {
    const safeMsg = error instanceof Error ? error.message : String(error);
    const safeStack = error instanceof Error ? error.stack : undefined;
    log.error(`Matrix bridge: failed to initialize appservice: ${safeMsg}\n${safeStack ?? ""}`);
    setMatrixBridge(null);
  }
}

export function isMatrixConfigured(): boolean {
  return getMatrixBridge() !== null;
}

export async function sendMatrixInviteSetupNotice(roomId: string): Promise<void> {
  await sendMatrixNotice(
    roomId,
    localizer("en-US", "matrix.notices.invited", {
      link_command: "/matrix link",
      help_command: "/help",
      room_id_path: "Room Settings -> Advanced -> Internal Room ID",
      kill_command: "/kill",
      refresh_command: "/refresh",
    }),
  );
}

export async function sendMatrixLinkedSetupNotice(roomId: string, locale: string, channelName: string): Promise<void> {
  await sendMatrixNotice(
    roomId,
    localizer(locale, "matrix.notices.linked", {
      channel_name: `#${channelName}`,
      help_command: "/help",
      kill_command: "/kill",
      refresh_command: "/refresh",
    }),
  );
}

async function sendMatrixNotice(roomId: string, text: string): Promise<void> {
  const bridge = getMatrixBridge();
  if (!bridge) return;

  try {
    await bridge.getIntent().sendMessage(roomId, {
      msgtype: "m.notice",
      body: text,
    });
  } catch (error) {
    log.warn(`Matrix bridge: failed to send notice to room ${roomId}`, error);
  }
}

function resolveRegistrationUrl(port: number): string {
  const configuredPublicUrl = process.env.MATRIX_APPSERVICE_PUBLIC_URL?.trim();
  const localhostHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const registrationUrl = `http://localhost:${port}`;

  if (!configuredPublicUrl) {
    return registrationUrl;
  }

  try {
    const parsedUrl = new URL(configuredPublicUrl);
    const isHttps = parsedUrl.protocol === "https:";
    const isLocalHttp = parsedUrl.protocol === "http:" && localhostHosts.has(parsedUrl.hostname);
    if (isHttps || isLocalHttp) {
      return configuredPublicUrl;
    }
  } catch (error) {
    log.warn(`Matrix bridge: invalid MATRIX_APPSERVICE_PUBLIC_URL "${configuredPublicUrl}"`, error);
  }

  log.warn(
    `Matrix bridge: invalid MATRIX_APPSERVICE_PUBLIC_URL "${configuredPublicUrl}" - ` +
      `must be https:// for remote endpoints (http:// allowed only for localhost). ` +
      `Falling back to ${registrationUrl}`,
  );
  return registrationUrl;
}
