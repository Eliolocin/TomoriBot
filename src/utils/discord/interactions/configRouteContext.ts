import {
  ComponentType,
  MessageFlags,
  type APIAttachment,
  type ChatInputCommandInteraction,
  type InteractionEditReplyOptions,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { PanelReadStatus, PanelReceipt } from "@/types/discord/panel";
import type { AddressingStyle } from "@/types/personaNaming";
import type { ConfigCategory, ConfigPage } from "@/utils/discord/configPanelCatalog";
import type { ConfigActor } from "@/utils/discord/interactions/configPermissionPolicy";
import type { ConfigPersonaOperations, GuildIdentityPort } from "@/utils/discord/interactions/configPersonaOperations";
import type { GlobalRoutableInteraction } from "@/utils/discord/interactions/routeRegistry";
import { type PersonaPanelAvatarData, withPersonaPanelAvatar } from "@/utils/discord/personaPanelAvatar";
import { buildConfigPanelPayload, type ConfigPanelView } from "@/utils/discord/ui/configPanel";
import type { RawModalPayload } from "@/utils/discord/ui/configModals";
import { buildPanelContainer } from "@/utils/discord/ui/panel";
import type { RecordPanelActionInput } from "@/utils/stats/panelActionMetrics";
import { localizer } from "@/utils/text/localizer";

export interface ConfigScope {
  /** Guild snowflake in a guild, DM recipient snowflake otherwise: the workspace key every absorbed command already uses. */
  serverDiscId: string;
  guildId: string | null;
  /** `servers` primary key, needed by telemetry and never the snowflake. */
  internalServerId: number | null;
  actor: ConfigActor;
  personas: TomoriState[];
  readStatus: PanelReadStatus;
}

export interface ConfigRouteDependencies {
  resolveScope(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    forceRefresh?: boolean,
  ): Promise<ConfigScope | null>;
  getPersonaAvatarData(
    interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
    persona: TomoriState,
  ): Promise<PersonaPanelAvatarData>;
  operations: ConfigPersonaOperations;
  createGuildIdentity(guildId: string, interaction: GlobalRoutableInteraction): GuildIdentityPort;
  recordAction(input: RecordPanelActionInput): void;
  createNonce(): string;
  showModal(interaction: GlobalRoutableInteraction, payload: RawModalPayload): Promise<void>;
  takeAvatarUpload(interactionId: string, nonce: string): APIAttachment | undefined;
  takeCheckboxValues(interactionId: string, fieldId: string): string[] | undefined;
}

export function terminalPayload(locale: string, key: string): InteractionEditReplyOptions {
  return {
    components: [
      buildPanelContainer([
        {
          type: ComponentType.TextDisplay,
          content: localizer(locale, key),
        },
      ]),
    ],
    attachments: [],
    flags: MessageFlags.IsComponentsV2,
  };
}

export function deniedReceipt(locale: string): PanelReceipt {
  return {
    tone: "error",
    heading: localizer(locale, "commands.config.panel.denied_heading"),
    detail: localizer(locale, "commands.config.panel.denied_detail"),
  };
}

export function staleReceipt(locale: string): PanelReceipt {
  return {
    tone: "warning",
    heading: localizer(locale, "commands.config.panel.stale_heading"),
    detail: localizer(locale, "commands.config.panel.stale_detail"),
  };
}

/**
 * Resolves the persona a route names against the workspace as it stands right now.
 *
 * A route ID outlives the row it points at, so a persona deleted or moved between servers must fall
 * back to the current main persona rather than reaching a persona in another workspace.
 */
export function resolveSelectedPersona(
  personas: readonly TomoriState[],
  requestedId: number | null,
): TomoriState | null {
  const requested = requestedId === null ? null : personas.find((persona) => persona.persona_id === requestedId);
  if (requested) return requested;
  return personas.find((persona) => persona.is_alter !== true) ?? personas[0] ?? null;
}

export interface ConfigRepaintOptions {
  locale: string;
  scope: ConfigScope;
  category: ConfigCategory;
  page: ConfigPage;
  selectedPersonaId: number | null;
  personaSelectStart?: number;
  namingStyle?: AddressingStyle;
  receipt?: PanelReceipt;
  view?: ConfigPanelView;
  dependencies: ConfigRouteDependencies;
}

export async function repaint(
  interaction: GlobalRoutableInteraction | ChatInputCommandInteraction,
  options: ConfigRepaintOptions,
): Promise<void> {
  const { locale, scope, category, page, selectedPersonaId, dependencies } = options;

  let avatar: PersonaPanelAvatarData | undefined;
  if (category === "persona") {
    const persona = scope.personas.find((candidate) => candidate.persona_id === selectedPersonaId);
    if (persona) avatar = await dependencies.getPersonaAvatarData(interaction, persona);
  }

  await interaction.editReply(
    withPersonaPanelAvatar(
      buildConfigPanelPayload({
        locale,
        actor: scope.actor,
        category,
        page,
        personas: scope.personas,
        selectedPersonaId,
        selectedPersonaAvatarUrl: avatar?.url,
        personaSelectStart: options.personaSelectStart,
        namingStyle: options.namingStyle,
        readStatus: scope.readStatus,
        receipt: options.receipt,
        view: options.view,
      }),
      avatar,
    ),
  );
}
