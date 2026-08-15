import type { ButtonInteraction, Client, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";

export type GlobalRoutableInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

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

export function parseInteractionRoute(customId: string): ParsedInteractionRoute | null {
  const [namespace, version, ...segments] = customId.split(":");
  if (!namespace || !version || segments.some((segment) => segment.length === 0)) {
    return null;
  }

  return { namespace, version, segments };
}

export class InteractionRouteRegistry {
  private readonly routes = new Map<string, GlobalInteractionRoute>();

  public constructor(routes: readonly GlobalInteractionRoute[]) {
    for (const route of routes) {
      const key = this.routeKey(route.namespace, route.version);
      if (this.routes.has(key)) {
        throw new Error(`Duplicate global interaction route: ${key}`);
      }
      this.routes.set(key, route);
    }
  }

  public async dispatch(client: Client, interaction: GlobalRoutableInteraction): Promise<boolean> {
    const parsed = parseInteractionRoute(interaction.customId);
    if (!parsed) {
      return false;
    }

    const route = this.routes.get(this.routeKey(parsed.namespace, parsed.version));
    if (!route) {
      return false;
    }

    await route.execute(client, interaction, parsed);
    return true;
  }

  private routeKey(namespace: string, version: string): string {
    return `${namespace}:${version}`;
  }
}
