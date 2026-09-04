/**
 * Components V2 reply-guard tests (Phase 1 of the paginated-modal-selector-consistency plan).
 *
 * Once a message carries `IsComponentsV2`, Discord permanently forbids editing it with
 * legacy `embeds`/`content`. `interactionCore` tracks such interactions in a WeakSet and
 * teaches the shared legacy sinks (`replyInfoEmbed`, `replySummaryEmbed`,
 * `replyPaginatedStatusPages`) to emit a V2 notice container instead of embeds when the
 * target is marked.
 *
 * These tests import the REAL `interactionCore` and use no `mock.module`, so the official
 * runner batches this file into the shared unit lane where `interactionCore` is never
 * mocked. See scripts/checks/runTests.ts (planLanes) and tests/unit/checks/
 * testIsolationHygiene.test.ts for why this keeps the real module intact.
 */

import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { AttachmentBuilder, ComponentType, MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction, Message } from "discord.js";
import * as componentsV2Limits from "@/utils/discord/ui/componentsV2Limits";
import { createMcpsInteractionRoute } from "@/utils/discord/interactions/mcpsRoutes";
import { createMemoriesInteractionRoute } from "@/utils/discord/interactions/memoriesRoutes";
import { createModerationInteractionRoute } from "@/utils/discord/interactions/moderationRoutes";
import { createPersonalMemoriesInteractionRoute } from "@/utils/discord/interactions/personalMemoriesRoutes";
import { createProvidersInteractionRoute } from "@/utils/discord/interactions/providersRoutes";
import { createStPresetsInteractionRoute } from "@/utils/discord/interactions/stPresetsRoutes";
import {
  ComponentsV2LimitError,
  buildPanelFallbackPayload,
  deliverGuardedPanel,
  hasComponentsV2Reply,
  isProductionEnvironment,
  markComponentsV2Reply,
  replyComponentsV2Status,
  replyInfoEmbed,
  validateComponentsV2MessageLimits,
  type ComponentsV2MessagePayload,
  type GuardedPanelDeliveryTarget,
  type GuardedPanelWorkflowController,
} from "@/utils/discord/ui/interactionCore";
import { log } from "@/utils/misc/logger";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import { initializeLocalizer } from "@/utils/text/localizer";

beforeAll(async () => initializeLocalizer());

/** One recorded acknowledgement call against the fake interaction. */
interface RecordedCall {
  method: "reply" | "editReply" | "webhook.send";
  payload: Record<string, unknown>;
}

/**
 * Minimal fake interaction that records the payload of every acknowledgement call.
 * `deferred` controls whether the sink routes to editReply (acknowledged) or reply.
 */
function makeInteraction(deferred: boolean): {
  interaction: ChatInputCommandInteraction;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const interaction = {
    id: "fake-interaction",
    deferred,
    replied: false,
    guild: null,
    user: { id: "user-1" },
    reply: async (payload: Record<string, unknown>) => {
      calls.push({ method: "reply", payload });
    },
    editReply: async (payload: Record<string, unknown>) => {
      calls.push({ method: "editReply", payload });
    },
    webhook: {
      send: async (payload: Record<string, unknown>) => {
        calls.push({ method: "webhook.send", payload });
      },
    },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, calls };
}

const infoOptions = {
  titleKey: "general.errors.unknown_error_title",
  descriptionKey: "general.errors.unknown_error_description",
  color: "#E74C3C",
} as const;

describe("Components V2 reply guard", () => {
  it("emits a legacy embed when the interaction is NOT marked (control)", async () => {
    const { interaction, calls } = makeInteraction(true);

    await replyInfoEmbed(interaction, "en-US", { ...infoOptions });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("editReply");
    // Legacy path carries embeds and an empty components array, never IsComponentsV2.
    expect(Array.isArray(call.payload.embeds)).toBe(true);
    expect(call.payload.flags).toBeUndefined();
  });

  it("emits a Components V2 notice (never embeds) when the interaction is marked — editReply path", async () => {
    const { interaction, calls } = makeInteraction(true);
    markComponentsV2Reply(interaction);

    await replyInfoEmbed(interaction, "en-US", { ...infoOptions });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("editReply");
    // The payload is a V2 component container.
    expect(call.payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(Array.isArray(call.payload.components)).toBe(true);
    expect((call.payload.components as unknown[]).length).toBeGreaterThan(0);
    // It MUST NOT carry legacy embeds, so Discord rejects those on a V2 message.
    expect("embeds" in call.payload).toBe(false);
  });

  it("emits an ephemeral Components V2 notice on the fresh reply path when marked", async () => {
    const { interaction, calls } = makeInteraction(false);
    markComponentsV2Reply(interaction);

    await replyInfoEmbed(interaction, "en-US", { ...infoOptions });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("reply");
    expect(call.payload.flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
    expect("embeds" in call.payload).toBe(false);
  });

  it("marks the interaction after replyComponentsV2Status writes a V2 payload", async () => {
    const { interaction } = makeInteraction(true);
    expect(hasComponentsV2Reply(interaction)).toBe(false);

    await replyComponentsV2Status(
      interaction,
      "en-US",
      "general.errors.unknown_error_title",
      "general.errors.unknown_error_description",
      "#3498DB",
    );

    // The status writer stamped IsComponentsV2 onto the reply, so a later legacy
    // sink on the same interaction must now render a V2 notice instead of embeds.
    expect(hasComponentsV2Reply(interaction)).toBe(true);
  });
});

function makeGuardedInteraction(options: { canUpdate?: boolean; canEditReply?: boolean; canReply?: boolean } = {}) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const interaction = {
    id: "guarded-interaction",
    deferred: true,
    replied: false,
    ...(options.canEditReply !== false
      ? {
          editReply: async (payload: unknown) => {
            calls.push({ method: "editReply", payload });
            return { id: "message-1", payload };
          },
        }
      : {}),
    ...(options.canUpdate
      ? {
          update: async (payload: unknown) => {
            calls.push({ method: "update", payload });
            return { id: "message-1", payload };
          },
        }
      : {}),
    ...(options.canReply
      ? {
          reply: async (payload: unknown) => {
            calls.push({ method: "reply", payload });
            return { id: "message-1", payload };
          },
        }
      : {}),
  } as unknown as GuardedPanelDeliveryTarget;
  return { interaction, calls };
}

function makeGuardedWorkflowController() {
  const calls: Array<{ method: string; payload: unknown; sourceInteraction?: unknown }> = [];
  const controller: GuardedPanelWorkflowController = {
    replace: async (payload: unknown) => {
      calls.push({ method: "replace", payload });
      return { id: "replaced-message", payload } as unknown as Message;
    },
    replaceFrom: async (sourceInteraction: unknown, payload: unknown) => {
      calls.push({ method: "replaceFrom", payload, sourceInteraction });
      return { id: "replaced-from-message", payload } as unknown as Message;
    },
  };
  return { controller, calls };
}

function validTestPanel(): ComponentsV2MessagePayload {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.TextDisplay,
            content: "Guarded Panel Content",
          },
        ],
      },
    ],
  };
}

describe("buildPanelFallbackPayload", () => {
  it("produces a valid Components V2 fallback panel passing limits validation", () => {
    const fallback = buildPanelFallbackPayload("en-US");
    expect(fallback.flags).toBe(MessageFlags.IsComponentsV2);
    expect(Array.isArray(fallback.components)).toBe(true);
    expect(fallback.components.length).toBeGreaterThan(0);

    const validation = validateComponentsV2MessageLimits(fallback);
    expect(validation.valid).toBe(true);
    expect(validation.violations).toHaveLength(0);
  });
});

describe("deliverGuardedPanel transports", () => {
  it("delivers via editReply and marks interaction as Components V2", async () => {
    const { interaction, calls } = makeGuardedInteraction({ canEditReply: true });
    expect(hasComponentsV2Reply(interaction)).toBe(false);

    const result = await deliverGuardedPanel(interaction, validTestPanel(), {
      method: "editReply",
      locale: "en-US",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("editReply");
    expect(hasComponentsV2Reply(interaction)).toBe(true);
    expect((result as { id?: string })?.id).toBe("message-1");
  });

  it("delivers via update and marks interaction as Components V2", async () => {
    const { interaction, calls } = makeGuardedInteraction({ canUpdate: true });
    expect(hasComponentsV2Reply(interaction)).toBe(false);

    const result = await deliverGuardedPanel(interaction, validTestPanel(), {
      method: "update",
      locale: "en-US",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("update");
    expect(hasComponentsV2Reply(interaction)).toBe(true);
    expect((result as { id?: string })?.id).toBe("message-1");
  });

  it("delivers via reply with custom flags and marks interaction as Components V2", async () => {
    const { interaction, calls } = makeGuardedInteraction({ canReply: true });
    expect(hasComponentsV2Reply(interaction)).toBe(false);

    const result = await deliverGuardedPanel(interaction, validTestPanel(), {
      method: "reply",
      locale: "en-US",
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("reply");
    expect((calls[0].payload as { flags?: number }).flags).toBe(MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
    expect(hasComponentsV2Reply(interaction)).toBe(true);
    expect((result as { id?: string })?.id).toBe("message-1");
  });

  it("delivers via controller.replace", async () => {
    const { controller, calls } = makeGuardedWorkflowController();
    const result = await deliverGuardedPanel(controller, validTestPanel(), {
      method: "replace",
      locale: "en-US",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("replace");
    expect((result as { id?: string })?.id).toBe("replaced-message");
  });

  it("delivers via controller.replaceFrom with sourceInteraction", async () => {
    const { controller, calls } = makeGuardedWorkflowController();
    const sourceInteraction = { id: "source-button" };
    const result = await deliverGuardedPanel(controller, validTestPanel(), {
      method: "replaceFrom",
      sourceInteraction,
      locale: "en-US",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("replaceFrom");
    expect(calls[0].sourceInteraction).toBe(sourceInteraction);
    expect((result as { id?: string })?.id).toBe("replaced-from-message");
  });

  it("delivers via custom callback function", async () => {
    const calls: unknown[] = [];
    const callback = async (payload: unknown) => {
      calls.push(payload);
      return "callback-done";
    };

    const result = await deliverGuardedPanel(callback, validTestPanel());
    expect(calls).toHaveLength(1);
    expect(result).toBe("callback-done");
  });

  it("preserves attachment files across transport (avatar panel)", async () => {
    const { interaction, calls } = makeGuardedInteraction({ canEditReply: true });
    const payloadWithAvatar = {
      ...validTestPanel(),
      files: [new AttachmentBuilder(Buffer.from("png-bytes"), { name: "panel_avatar.png" })],
    };

    await deliverGuardedPanel(interaction, payloadWithAvatar, {
      method: "editReply",
      locale: "en-US",
    });

    expect(calls).toHaveLength(1);
    const deliveredPayload = calls[0].payload as { files?: AttachmentBuilder[] };
    expect(deliveredPayload.files).toHaveLength(1);
    expect(deliveredPayload.files?.[0].name).toBe("panel_avatar.png");
  });
});

describe("deliverGuardedPanel budget enforcement and redaction", () => {
  // Bun batches this file's lane with others in one process, so an env var left set here changes
  // behaviour in a different file and fails there instead. The per-test finally blocks cannot cover
  // a throw before their try, and tests/unit/checks/testIsolationHygiene.test.ts requires the undo
  // to live in a hook it can find by name.
  const originalGuardEnv = {
    RUN_ENV: process.env.RUN_ENV,
    ERROR_DB_LOGGING_ENABLED: process.env.ERROR_DB_LOGGING_ENABLED,
  };
  afterEach(() => {
    if (originalGuardEnv.RUN_ENV === undefined) delete process.env.RUN_ENV;
    else process.env.RUN_ENV = originalGuardEnv.RUN_ENV;
    if (originalGuardEnv.ERROR_DB_LOGGING_ENABLED === undefined) delete process.env.ERROR_DB_LOGGING_ENABLED;
    else process.env.ERROR_DB_LOGGING_ENABLED = originalGuardEnv.ERROR_DB_LOGGING_ENABLED;
  });

  it("fails loud in development/test mode with ComponentsV2LimitError", async () => {
    const originalRunEnv = process.env.RUN_ENV;
    delete process.env.RUN_ENV;
    try {
      expect(isProductionEnvironment()).toBe(false);
      const { interaction, calls } = makeGuardedInteraction({ canEditReply: true });

      const overBudgetPayload = {
        flags: MessageFlags.IsComponentsV2,
        components: [
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: "A".repeat(4005),
              },
            ],
          },
        ],
      };

      let caughtError: unknown;
      try {
        await deliverGuardedPanel(interaction, overBudgetPayload, {
          method: "editReply",
          locale: "en-US",
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ComponentsV2LimitError);
      expect((caughtError as ComponentsV2LimitError).message).toContain("TEXT_DISPLAY_TOTAL_EXCEEDED");
      expect((caughtError as ComponentsV2LimitError).violations.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(0);
      expect(hasComponentsV2Reply(interaction)).toBe(false);
    } finally {
      process.env.RUN_ENV = originalRunEnv;
    }
  });

  it("delivers fallback panel and redacts sensitive content in production mode", async () => {
    const originalRunEnv = process.env.RUN_ENV;
    const originalDbLog = process.env.ERROR_DB_LOGGING_ENABLED;
    const originalLogError = log.error;
    process.env.RUN_ENV = "production";
    process.env.ERROR_DB_LOGGING_ENABLED = "false";

    const loggedErrors: Array<{ msg: string; err?: unknown; context?: unknown }> = [];
    log.error = async (msg: string, err?: unknown, context?: unknown) => {
      loggedErrors.push({ msg, err, context });
    };

    try {
      expect(isProductionEnvironment()).toBe(true);
      const { interaction, calls } = makeGuardedInteraction({ canEditReply: true });

      const SECRET_SENTINEL = "STORED_PROMPT_SECRET_SENTINEL_12345";
      const overBudgetPayload = {
        flags: MessageFlags.IsComponentsV2,
        components: [
          {
            type: ComponentType.Container,
            components: [
              {
                type: ComponentType.TextDisplay,
                content: `${SECRET_SENTINEL} - `.repeat(150), // > 4000 chars
              },
            ],
          },
        ],
      };

      const result = await deliverGuardedPanel(interaction, overBudgetPayload, {
        method: "editReply",
        locale: "en-US",
      });

      // Does not throw in production mode
      expect(result).toBeDefined();

      // Interaction received fallback payload
      expect(calls).toHaveLength(1);
      const receivedPayload = calls[0].payload as ComponentsV2MessagePayload;
      expect(receivedPayload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(hasComponentsV2Reply(interaction)).toBe(true);

      // Verify log was called with redacted metadata
      expect(loggedErrors.length).toBeGreaterThan(0);
      const loggedEntry = loggedErrors[0];
      const serializedLog = JSON.stringify(loggedEntry);

      // Log must NOT contain the sensitive prompt string
      expect(serializedLog).not.toContain(SECRET_SENTINEL);

      // Log MUST contain structured violation metadata
      const context = loggedEntry.context as {
        metadata?: { violations?: Array<{ code: string; limit: number; observed: number }> };
      };
      const violations = context?.metadata?.violations;
      expect(Array.isArray(violations)).toBe(true);
      expect(violations?.[0].code).toBe("TEXT_DISPLAY_TOTAL_EXCEEDED");
      expect(violations?.[0].limit).toBe(4000);
      expect(violations?.[0].observed).toBeGreaterThan(4000);
    } finally {
      process.env.RUN_ENV = originalRunEnv;
      process.env.ERROR_DB_LOGGING_ENABLED = originalDbLog;
      log.error = originalLogError;
    }
  });
});

describe("after-write invariant preservation", () => {
  it("preserves interaction continuity after a state mutation in production", async () => {
    const originalRunEnv = process.env.RUN_ENV;
    const originalDbLog = process.env.ERROR_DB_LOGGING_ENABLED;
    const originalLogError = log.error;
    process.env.RUN_ENV = "production";
    process.env.ERROR_DB_LOGGING_ENABLED = "false";
    log.error = async () => {};

    try {
      let writeCommitted = false;
      const { interaction, calls } = makeGuardedInteraction({ canUpdate: true });

      // Simulate performPanelAction lifecycle: write -> reload -> repaint
      const performAction = async () => {
        writeCommitted = true;

        // Builder generates an over-budget payload
        const overBudgetRepaintPayload = {
          flags: MessageFlags.IsComponentsV2,
          components: [
            {
              type: ComponentType.Container,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: "X".repeat(4005),
                },
              ],
            },
          ],
        };

        // Repaint uses deliverGuardedPanel
        await deliverGuardedPanel(interaction, overBudgetRepaintPayload, {
          method: "update",
          locale: "en-US",
        });
      };

      await expect(performAction()).resolves.toBeUndefined();
      expect(writeCommitted).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("update");
    } finally {
      process.env.RUN_ENV = originalRunEnv;
      process.env.ERROR_DB_LOGGING_ENABLED = originalDbLog;
      log.error = originalLogError;
    }
  });

  it("fails loud on after-write repaint in development mode to alert tests", async () => {
    const originalRunEnv = process.env.RUN_ENV;
    delete process.env.RUN_ENV;

    try {
      let writeCommitted = false;
      const { interaction, calls } = makeGuardedInteraction({ canUpdate: true });

      const performAction = async () => {
        writeCommitted = true;

        const overBudgetRepaintPayload = {
          flags: MessageFlags.IsComponentsV2,
          components: [
            {
              type: ComponentType.Container,
              components: [
                {
                  type: ComponentType.TextDisplay,
                  content: "X".repeat(4005),
                },
              ],
            },
          ],
        };

        await deliverGuardedPanel(interaction, overBudgetRepaintPayload, {
          method: "update",
          locale: "en-US",
        });
      };

      await expect(performAction()).rejects.toBeInstanceOf(ComponentsV2LimitError);
      expect(writeCommitted).toBe(true);
      expect(calls).toHaveLength(0);
    } finally {
      process.env.RUN_ENV = originalRunEnv;
    }
  });
});

describe("delivery-tier construction validation", () => {
  it("validates every private terminal notice builder on its real route path", async () => {
    const validationSpy = spyOn(componentsV2Limits, "validateComponentsV2MessageLimits");
    const cases = [
      {
        name: "mcps",
        route: createMcpsInteractionRoute({ resolveScope: async () => null }),
        customId: "mcps:v1:retry:en-US:none",
        interactionKind: "button" as const,
        guildId: undefined,
      },
      {
        name: "memories",
        route: createMemoriesInteractionRoute({ resolveScope: async () => null }),
        customId: "memories:v1:retry:en-US:documents",
        interactionKind: "button" as const,
        guildId: undefined,
      },
      {
        name: "moderation",
        route: createModerationInteractionRoute(),
        customId: "moderation:v1:member-access-submit:en-US:abcdefgh",
        interactionKind: "modal" as const,
        guildId: "guild-1",
      },
      {
        name: "personal memories",
        route: createPersonalMemoriesInteractionRoute({ resolveScope: async () => null }),
        customId: "personal-memories:v1:retry:en-US:global:0",
        interactionKind: "button" as const,
        guildId: undefined,
      },
      {
        name: "providers",
        route: createProvidersInteractionRoute({ resolveScope: async () => null }),
        customId: "providers:v1:retry:en-US",
        interactionKind: "button" as const,
        guildId: undefined,
      },
      {
        name: "st presets",
        route: createStPresetsInteractionRoute({ resolveScope: async () => null }),
        customId: "st-presets:v1:retry:en-US",
        interactionKind: "button" as const,
        guildId: undefined,
      },
    ];

    try {
      for (const testCase of cases) {
        const calls: unknown[] = [];
        const interaction = {
          id: `delivery-probe-${testCase.name}`,
          customId: testCase.customId,
          guildId: testCase.guildId,
          user: { id: "user-1" },
          memberPermissions: { has: () => false },
          isButton: () => testCase.interactionKind === "button",
          isModalSubmit: () => testCase.interactionKind === "modal",
          isStringSelectMenu: () => false,
          deferUpdate: async () => calls.push("deferUpdate"),
          editReply: async (payload: unknown) => calls.push(payload),
        };
        const parsed = parseInteractionRoute(testCase.customId);
        expect(parsed, `${testCase.name} route should parse`).not.toBeNull();
        await testCase.route.execute({} as never, interaction as never, parsed as never);

        const payloads = calls.filter((call): call is ComponentsV2MessagePayload => typeof call === "object");
        expect(payloads, `${testCase.name} should edit a terminal payload`).toHaveLength(1);
        expect(validateComponentsV2MessageLimits(payloads[0]).valid).toBe(true);
      }

      expect(validationSpy).toHaveBeenCalledTimes(cases.length * 2);
    } finally {
      validationSpy.mockRestore();
    }
  });
});
