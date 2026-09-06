import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType, type Client } from "discord.js";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { formatMcpServers } from "@/utils/metrics/mcpStatus";
import { formatUserSavedProviders } from "@/utils/metrics/providerStats";
import {
  formatMatrixLinks,
  formatRandomTriggers,
  formatWelcomeChannel,
} from "@/utils/metrics/status/channelFormatters";
import { formatOptionalApiKeys } from "@/utils/metrics/status/providerConfigFormatters";
import { formatCustomEndpoints, formatRotationPoolValue } from "@/utils/metrics/status/sharedFormatters";
import {
  buildDashboardPagePayload,
  type StatusCategory,
  type StatusPageCategory,
} from "@/utils/metrics/status/statusPageRenderer";
import { buildStatsDashboardPayload, type StatsTab } from "@/utils/stats/statsDashboard";
import { initializeLocalizer } from "@/utils/text/localizer";

const RUNTIME_LOCALES = ["en-US", "ja"] as const;
const COMPONENT_BUDGET = 36;
const COMPONENT_RESERVE = 4;

beforeAll(async () => {
  await initializeLocalizer();
});

function countComponents(component: unknown): number {
  if (Array.isArray(component)) return component.reduce((total, item) => total + countComponents(item), 0);
  if (!component || typeof component !== "object") return 0;
  const value = component as { components?: unknown[] };
  return 1 + (value.components?.reduce((total, item) => total + countComponents(item), 0) ?? 0);
}

function buildPage(category: StatusCategory, populated: boolean): SummaryEmbedOptions {
  const titleKeyByCategory: Record<StatusCategory, string> = {
    persona: "commands.status.persona_page1_title",
    behavior: "commands.status.server_page1_title",
    models: "commands.status.server_page4_title",
    access: "commands.status.server_page8_title",
    personal: "commands.status.personal_title",
  };
  const descriptionKeyByCategory: Record<StatusCategory, string> = {
    persona: "commands.status.persona_page1_description",
    behavior: "commands.status.server_page1_description",
    models: "commands.status.server_page4_description",
    access: "commands.status.server_page8_description",
    personal: "commands.status.personal_description",
  };
  const fieldKeyByCategory: Record<StatusCategory, string> = {
    persona: "commands.status.field_nickname",
    behavior: "commands.status.field_timezone",
    models: "commands.status.field_model",
    access: "commands.status.field_tool_use",
    personal: "commands.status.field_user_nickname",
  };

  return {
    titleKey: titleKeyByCategory[category],
    titleVars: category === "persona" ? { persona_name: "Sparrow" } : undefined,
    descriptionKey: descriptionKeyByCategory[category],
    color: 0x65c6c5,
    fields: Array.from({ length: populated ? 12 : 2 }, (_, index) => ({
      nameKey: fieldKeyByCategory[category],
      value: populated ? `configured value ${index + 1}` : "None",
      inline: index % 3 !== 0,
    })),
  };
}

function buildCategories(populated: boolean): StatusPageCategory[] {
  return (["persona", "behavior", "models", "access", "personal"] as const).map((id) => ({
    id,
    labelKey: `commands.status.scope_choice_${id}`,
    pages: [buildPage(id, populated)],
  }));
}

describe("status Components V2 limits and redaction", () => {
  it("keeps every category below the 36-component budget across runtime locales and read states", () => {
    for (const locale of RUNTIME_LOCALES) {
      for (const populated of [false, true]) {
        for (const category of buildCategories(populated)) {
          const payload = buildDashboardPagePayload({
            locale,
            page: category.pages[0],
            buttonRows: [
              {
                type: ComponentType.ActionRow,
                components: buildCategories(populated).map((candidate) => ({
                  type: ComponentType.Button,
                  customId: `test:${candidate.id}`,
                  label: candidate.id,
                  style: ButtonStyle.Secondary,
                })),
              },
            ],
          });
          const componentCount = countComponents(payload.components);

          expect(componentCount).toBeLessThanOrEqual(COMPONENT_BUDGET);
          expect(40 - componentCount).toBeGreaterThanOrEqual(COMPONENT_RESERVE);
          expect(validateComponentsV2MessageLimits(payload).valid).toBe(true);
        }
      }
    }
  });

  it("places category controls above the page body", () => {
    const payload = buildDashboardPagePayload({
      locale: "en-US",
      page: buildPage("behavior", true),
      buttonRows: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              customId: "test:behavior",
              label: "Behavior",
              style: ButtonStyle.Primary,
            },
          ],
        },
      ],
    });
    const components = (payload.components[0] as { components: Array<{ type: ComponentType }> }).components;

    expect(components[0].type).toBe(ComponentType.ActionRow);
    expect(components[1].type).toBe(ComponentType.Separator);
    expect(components[2].type).toBe(ComponentType.TextDisplay);
  });

  it("places stats tab controls above the shared page body", () => {
    const tabs: StatsTab[] = [
      {
        id: "overview",
        labelKey: "commands.stats.tab.overview",
        page: {
          titleKey: "commands.stats.server.title",
          subtitle: "Status overview.",
          fields: [{ kind: "stat", nameKey: "commands.stats.messages", value: "1", inline: true }],
        },
      },
      {
        id: "people",
        labelKey: "commands.stats.tab.people",
        page: {
          titleKey: "commands.stats.server.title",
          subtitle: "People overview.",
          fields: [{ kind: "stat", nameKey: "commands.stats.messages", value: "2", inline: true }],
        },
      },
    ];
    const payload = buildStatsDashboardPayload("stats-test", tabs, 0, "en-US", true);
    const components = (payload.components[0] as { components: Array<{ type: ComponentType }> }).components;

    expect(components[0].type).toBe(ComponentType.ActionRow);
    expect(components[1].type).toBe(ComponentType.Separator);
    expect(components[2].type).toBe(ComponentType.TextDisplay);
  });

  it("continues to render redacted endpoint and MCP status values", () => {
    const endpointSecret = "https://operator:secret@example.invalid/private?token=secret";
    const mcpToken = "mcp-secret-token";
    const endpointText = formatCustomEndpoints(
      [
        {
          label: "Lighthouse",
          model_name: "lighthouse-model",
          capability: "text",
          api_style: "openai",
          requires_auth: true,
          base_url: endpointSecret,
        },
      ] as Parameters<typeof formatCustomEndpoints>[0],
      "en-US",
    );
    const mcpText = formatMcpServers(
      [
        {
          name: "Sparrow MCP",
          is_enabled: true,
          server_type: "custom",
          auth_token: Buffer.from(mcpToken),
        },
      ] as Parameters<typeof formatMcpServers>[0],
      "en-US",
    );
    const payload = buildDashboardPagePayload({
      locale: "en-US",
      page: {
        titleKey: "commands.status.server_page7_title",
        fields: [
          { nameKey: "commands.status.field_server_custom_endpoints_with_count", value: endpointText },
          { nameKey: "commands.status.field_mcp_servers_with_count", value: mcpText },
        ],
      },
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain(endpointSecret);
    expect(serialized).not.toContain(mcpToken);
    expect(serialized).toContain("lighthouse-model");
    expect(serialized).toContain("Sparrow MCP");
  });

  it("keeps API values, Matrix room IDs, and custom prompts out of rendered status output", async () => {
    const locale = "en-US";
    const apiKeySecret = "server-api-secret";
    const matrixRoomId = "!private-room:matrix.example";
    const randomPromptSecret = "random-trigger-prompt-secret";
    const client = {
      channels: { fetch: async (id: string) => ({ id }) },
    } as unknown as Client;

    // Status receives API presence and counts, not secret values. The Matrix query in
    // serverConfigPages.ts selects only channel_disc_id, so room IDs cannot reach this formatter.
    const optionalApiKeysValue = formatOptionalApiKeys(["brave-search"], locale);
    const rotationPoolValue = formatRotationPoolValue(
      [{ api_key: Buffer.from(apiKeySecret), is_main_key_pointer: false, is_enabled: true }] as Parameters<
        typeof formatRotationPoolValue
      >[0],
      locale,
    );
    const personalProviderValue = formatUserSavedProviders(
      [
        { provider: "custom", enabled_capabilities: ["text"], api_key: Buffer.from(apiKeySecret) },
      ] as unknown as Parameters<typeof formatUserSavedProviders>[0],
      locale,
    );
    const welcomeChannelValue = await formatWelcomeChannel(
      client,
      { welcome_channel_disc_id: "welcome-channel", welcome_persona_id: null } as Parameters<
        typeof formatWelcomeChannel
      >[1],
      new Map(),
      locale,
    );
    const randomTriggersValue = await formatRandomTriggers(
      client,
      [
        {
          channel_disc_id: "random-channel",
          persona_id: null,
          timer_hours: 4,
          random_offset_range: null,
          chance_percent: 25,
          silence_threshold_hours: null,
          respond_to_self: false,
          custom_prompt: randomPromptSecret,
          failure_threshold: null,
        },
      ] as Parameters<typeof formatRandomTriggers>[1],
      new Map(),
      locale,
    );
    const matrixLinksValue = await formatMatrixLinks(
      client,
      [{ channel_disc_id: "matrix-channel", matrix_room_id: matrixRoomId }] as unknown as Parameters<
        typeof formatMatrixLinks
      >[1],
      locale,
    );

    const payload = buildDashboardPagePayload({
      locale,
      page: {
        titleKey: "commands.status.server_page7_title",
        fields: [
          { nameKey: "commands.status.field_optional_api_keys_with_count", value: optionalApiKeysValue },
          { nameKey: "commands.status.field_api_key_rotation_pool", value: rotationPoolValue },
          { nameKey: "commands.status.field_personal_providers_with_count", value: personalProviderValue },
          { nameKey: "commands.status.field_welcome_channel", value: welcomeChannelValue },
          { nameKey: "commands.status.field_random_triggers", value: randomTriggersValue },
          { nameKey: "commands.status.field_matrix_links_with_count", value: matrixLinksValue },
        ],
      },
    });
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain(optionalApiKeysValue);
    expect(serialized).toContain(rotationPoolValue);
    expect(serialized).toContain(personalProviderValue);
    expect(serialized).toContain(welcomeChannelValue);
    expect(serialized).toContain(randomTriggersValue);
    expect(serialized).toContain(matrixLinksValue);
    expect(serialized).not.toContain(apiKeySecret);
    expect(serialized).not.toContain(matrixRoomId);
    expect(serialized).not.toContain(randomPromptSecret);
  });
});
