import type {
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  Client,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";

export type GlobalRoutableInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ChannelSelectMenuInteraction
  | ModalSubmitInteraction;

export interface ParsedInteractionRoute {
  namespace: string;
  version: string;
  segments: string[];
}

export interface GlobalInteractionRoute {
  namespace: string;
  version: string;
  execute(client: Client, interaction: GlobalRoutableInteraction, route: ParsedInteractionRoute): Promise<void>;
}

export type InteractionRouteDispatchResult = "handled" | "stale-version" | "unmatched";
export const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;

export function buildInteractionRouteId(namespace: string, version: string, ...segments: string[]): string {
  const values = [namespace, version, ...segments];
  if (values.some((value) => !value || value.includes(":"))) {
    throw new Error("Interaction route segments must be non-empty and cannot contain colons");
  }
  const customId = values.join(":");
  if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
    throw new Error(`Interaction custom ID exceeds ${DISCORD_CUSTOM_ID_MAX_LENGTH} characters`);
  }
  return customId;
}

export function parseInteractionRoute(customId: string): ParsedInteractionRoute | null {
  const [namespace, version, ...segments] = customId.split(":");
  if (!namespace || !version || segments.some((segment) => segment.length === 0)) {
    return null;
  }

  return { namespace, version, segments };
}

export class InteractionRouteRegistry {
  private readonly routes = new Map<string, GlobalInteractionRoute>();
  private readonly namespaces = new Set<string>();

  public constructor(routes: readonly GlobalInteractionRoute[]) {
    for (const route of routes) {
      const key = this.routeKey(route.namespace, route.version);
      if (this.routes.has(key)) {
        throw new Error(`Duplicate global interaction route: ${key}`);
      }
      this.routes.set(key, route);
      this.namespaces.add(route.namespace);
    }
  }

  public async dispatch(client: Client, interaction: GlobalRoutableInteraction): Promise<boolean> {
    return (await this.dispatchDetailed(client, interaction)) !== "unmatched";
  }

  public async dispatchDetailed(
    client: Client,
    interaction: GlobalRoutableInteraction,
  ): Promise<InteractionRouteDispatchResult> {
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) {
      return "unmatched";
    }

    const route = this.routes.get(this.routeKey(parsed.namespace, parsed.version));
    if (!route) {
      return this.namespaces.has(parsed.namespace) ? "stale-version" : "unmatched";
    }

    await route.execute(client, interaction, parsed);
    return "handled";
  }

  private routeKey(namespace: string, version: string): string {
    return `${namespace}:${version}`;
  }
}
