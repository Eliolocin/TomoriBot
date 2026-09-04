import { beforeAll, describe, expect, it } from "bun:test";
import { ButtonStyle, MessageFlags, type TopLevelComponentData } from "discord.js";
import { terminalPayload as buildConfigTerminalPayload } from "@/utils/discord/interactions/configRouteContext";
import { terminalPayload as buildPersonalConfigTerminalPayload } from "@/utils/discord/interactions/personalConfigRouteContext";
import { buildGeneratedImageComponentsV2Payload } from "@/utils/discord/generatedImageMessage";
import { buildGeneratedVideoComponentsV2Payload } from "@/utils/discord/generatedVideoMessage";
import { buildProviderPickerPayload } from "@/utils/discord/ui/anchorModelFlow";
import { buildRangeSelectorPayload } from "@/utils/discord/ui/interactionCore";
import { buildPersonaWorkflowNotice } from "@/utils/discord/ui/personaWorkflow";
import { validateComponentsV2MessageLimits } from "@/utils/discord/ui/componentsV2Limits";
import { buildStatsDashboardPayload, type StatsTab } from "@/utils/stats/statsDashboard";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

function assertValidPayload(
  payload: { components: TopLevelComponentData[]; flags: MessageFlags },
  label: string,
): void {
  expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  const result = validateComponentsV2MessageLimits(payload);
  expect(result.valid, `${label} violations: ${JSON.stringify(result.violations)}`).toBe(true);
}

describe("Declared Components V2 producer smoke fixtures", () => {
  it("validates the config route terminal payload", () => {
    assertValidPayload(
      buildConfigTerminalPayload("en-US", "general.errors.permission_denied_description"),
      "configRouteContext.terminalPayload",
    );
  });

  it("validates the personal config route terminal payload", () => {
    assertValidPayload(
      buildPersonalConfigTerminalPayload("en-US", "general.errors.permission_denied_description"),
      "personalConfigRouteContext.terminalPayload",
    );
  });

  it("validates generated image and video payload builders", () => {
    assertValidPayload(
      buildGeneratedImageComponentsV2Payload("generated.png", 1_250, "en-US", ["Sparrow"]),
      "generatedImageMessage.buildGeneratedImageComponentsV2Payload",
    );
    assertValidPayload(
      buildGeneratedVideoComponentsV2Payload("generated.mp4", 2_500, "en-US"),
      "generatedVideoMessage.buildGeneratedVideoComponentsV2Payload",
    );
  });

  it("validates the anchor model picker payload", () => {
    assertValidPayload(
      buildProviderPickerPayload(
        "en-US",
        "smoke-picker",
        ["google", "openrouter"],
        [{ provider: "google", model: "gemini/example" }],
        { note: "Choose a provider for this model capability." },
      ),
      "anchorModelFlow.buildProviderPickerPayload",
    );
  });

  it("validates the shared interaction-core range selector payload", () => {
    assertValidPayload(
      buildRangeSelectorPayload("en-US", "smoke-range", 26, 0),
      "interactionCore.buildRangeSelectorPayload",
    );
  });

  it("validates the persona workflow notice payload", () => {
    assertValidPayload(
      buildPersonaWorkflowNotice({
        locale: "en-US",
        titleKey: "general.persona_workflow.modal_ready_title",
        descriptionKey: "general.persona_workflow.modal_ready_description",
        button: {
          customId: "smoke-open",
          labelKey: "general.persona_workflow.open_modal_button",
          style: ButtonStyle.Secondary,
        },
      }),
      "personaWorkflow.buildPersonaWorkflowNotice",
    );
  });

  it("validates the stats dashboard payload", () => {
    const tabs: StatsTab[] = [
      {
        id: "overview",
        labelKey: "commands.stats.tabs.overview_label",
        page: {
          titleKey: "commands.stats.tabs.overview_title",
          subtitle: "Representative statistics",
          footerKey: "commands.stats.footer",
          fields: [],
        },
      },
    ];
    assertValidPayload(
      buildStatsDashboardPayload("smoke-stats", tabs, 0, "en-US", true),
      "statsDashboard.buildStatsDashboardPayload",
    );
  });
});
