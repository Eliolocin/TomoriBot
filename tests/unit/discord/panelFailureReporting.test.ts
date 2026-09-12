import { describe, expect, it } from "bun:test";
import { ComponentType, MessageFlags } from "discord.js";
import type { PanelReceipt } from "@/types/discord/panel";
import { deliverGuardedPanel } from "@/utils/discord/ui/interactionCore";
import { setupNoticeReceipt } from "@/utils/discord/ui/setupPanel";
import { log } from "@/utils/misc/logger";
import { initializeLocalizer } from "@/utils/text/localizer";

await initializeLocalizer();

interface RecordedMetric {
  name: string;
  fields: Record<string, number | string>;
}

/**
 * Captures `log.metric` without touching pino.
 *
 * The panel failure signal is a metric rather than an error record by design (the error level is
 * reserved for incidents, and most receipts are expected refusals), so asserting the metric is
 * asserting the contract.
 */
function captureMetrics(): { metrics: RecordedMetric[]; restore(): void } {
  const metrics: RecordedMetric[] = [];
  const original = log.metric;
  log.metric = (name: string, fields: Record<string, number | string>) => {
    metrics.push({ name, fields });
  };
  return { metrics, restore: () => Object.assign(log, { metric: original }) };
}

const ERROR_RECEIPT: PanelReceipt = {
  tone: "error",
  heading: "Update Failed",
  detail: "Failed to update the configuration in the database. Please try again.",
  reason: "custom_endpoint_unreachable",
};

const WARNING_RECEIPT: PanelReceipt = {
  tone: "warning",
  heading: "Panel Out Of Date",
  detail: "That persona changed. The panel has been refreshed.",
};

const SUCCESS_RECEIPT: PanelReceipt = {
  tone: "success",
  heading: "Saved",
  detail: "The change was saved.",
};

function fakeInteraction(customId: string): { customId: string; editReply: (payload: unknown) => Promise<unknown> } {
  return {
    customId,
    editReply: async () => undefined,
  };
}

/** Minimal Components V2 payload that satisfies the delivery validator. */
function validPayload(content = "### Update Failed\n> Try again."): {
  components: unknown[];
  flags: MessageFlags;
} {
  return {
    components: [{ type: ComponentType.Container, components: [{ type: ComponentType.TextDisplay, content }] }],
    flags: MessageFlags.IsComponentsV2,
  };
}

describe("panel failure reporting chokepoint", () => {
  it("reports an error receipt once, naming the namespace from the interaction route id", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      const interaction = fakeInteraction("config:v1:page:en-US:models");
      await deliverGuardedPanel(interaction, validPayload(), { locale: "en-US", receipt: ERROR_RECEIPT });

      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.name).toBe("panel_failure");
      expect(metrics[0]?.fields.tone).toBe("error");
      expect(metrics[0]?.fields.namespace).toBe("config");
      expect(metrics[0]?.fields.reason).toBe("custom_endpoint_unreachable");
      expect(metrics[0]?.fields.heading).toBe("Update Failed");
      expect(metrics[0]?.fields.locale).toBe("en-US");
    } finally {
      restore();
    }
  });

  it("falls back to a namespace and tone key when the receipt names no cause", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await deliverGuardedPanel(fakeInteraction("moderation:v1:page:en-US"), validPayload(), {
        locale: "en-US",
        receipt: { tone: "error", heading: "Update Failed", detail: "Try again." },
      });
      // The heading is localized, so it cannot be the grouping key; the fallback stays stable
      // across locales by using the route namespace instead.
      expect(metrics[0]?.fields.reason).toBe("moderation_error");
    } finally {
      restore();
    }
  });

  it("keeps the fallback key stable when the target carries no route id", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await deliverGuardedPanel(async () => undefined, validPayload(), {
        locale: "en-US",
        receipt: { tone: "error", heading: "Update Failed", detail: "Try again." },
      });
      expect(metrics[0]?.fields.namespace).toBe("unknown");
      expect(metrics[0]?.fields.reason).toBe("unknown_error");
    } finally {
      restore();
    }
  });

  it("reports a warning receipt as well, because a stale panel still failed the actor's intent", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await deliverGuardedPanel(fakeInteraction("moderation:v1:page:en-US"), validPayload(), {
        locale: "en-US",
        receipt: WARNING_RECEIPT,
      });
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.fields.tone).toBe("warning");
    } finally {
      restore();
    }
  });

  it("stays silent for a success or info receipt and for a delivery with no receipt", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await deliverGuardedPanel(fakeInteraction("providers:v1:page:en-US"), validPayload(), {
        locale: "en-US",
        receipt: SUCCESS_RECEIPT,
      });
      await deliverGuardedPanel(fakeInteraction("providers:v1:page:en-US"), validPayload(), { locale: "en-US" });
      expect(metrics).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("keeps the user-visible payload free of any diagnostic text", async () => {
    const delivered: unknown[] = [];
    const interaction = {
      customId: "config:v1:page:en-US:models",
      editReply: async (payload: unknown) => {
        delivered.push(payload);
        return undefined;
      },
    };
    await deliverGuardedPanel(interaction, validPayload(), { locale: "en-US", receipt: ERROR_RECEIPT });

    // The receipt travels beside the payload rather than inside it, so the payload is byte-for-byte
    // what a caller built and costs the panel none of its Discord text budget.
    expect(JSON.stringify(delivered[0])).toBe(JSON.stringify(validPayload()));
  });

  it("delivers the panel even when metric recording throws", async () => {
    const original = log.metric;
    log.metric = () => {
      throw new Error("metrics sink unavailable");
    };
    try {
      let delivered = false;
      await deliverGuardedPanel(
        {
          customId: "config:v1:page:en-US",
          editReply: async () => {
            delivered = true;
            return undefined;
          },
        },
        validPayload(),
        { locale: "en-US", receipt: ERROR_RECEIPT },
      );
      expect(delivered).toBe(true);
    } finally {
      Object.assign(log, { metric: original });
    }
  });
});

describe("setup wizard terminal notice receipts", () => {
  it("reports a failed commit as an error and an expired session as a warning", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      const interaction = fakeInteraction("setup:v1:finish:en-US:nonce1234");
      await deliverGuardedPanel(interaction, validPayload(), {
        locale: "en-US",
        receipt: setupNoticeReceipt("en-US", "commit-failed"),
      });
      await deliverGuardedPanel(interaction, validPayload(), {
        locale: "en-US",
        receipt: setupNoticeReceipt("en-US", "expired"),
      });

      // A failed commit is a genuine incident the actor must rerun, and it previously emitted
      // nothing at all; an expired session is routine drift.
      expect(metrics.map((entry) => entry.fields.reason)).toEqual(["setup_commit_failed", "setup_session_expired"]);
      expect(metrics.map((entry) => entry.fields.tone)).toEqual(["error", "warning"]);
      expect(metrics[0]?.fields.namespace).toBe("setup");
    } finally {
      restore();
    }
  });

  it("stays silent for the in-flight notice, which is not a failure", async () => {
    const { metrics, restore } = captureMetrics();
    try {
      await deliverGuardedPanel(fakeInteraction("setup:v1:finish:en-US:nonce1234"), validPayload(), {
        locale: "en-US",
        receipt: setupNoticeReceipt("en-US", "in-flight"),
      });
      expect(metrics).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
