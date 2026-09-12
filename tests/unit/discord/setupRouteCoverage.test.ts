import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parseInteractionRoute } from "@/utils/discord/interactions/routeRegistry";
import {
  parseSetupRoute,
  SETUP_ROUTE_NAMESPACE,
  SETUP_ROUTE_VERSION,
  type SetupWizardAction,
} from "@/utils/discord/interactions/setupRoutes";
import {
  buildSetupByokModal,
  buildSetupCancelledPayload,
  buildSetupCatalogModal,
  buildSetupCommitFailedPayload,
  buildSetupEndpointConnectionModal,
  buildSetupEndpointModelModal,
  buildSetupExpiredPayload,
  buildSetupInFlightPayload,
  buildSetupPoliciesModal,
  buildSetupSettingsModal,
  buildSetupSuccessPayload,
  buildSetupWizardPayload,
  type SetupSettingsCatalogs,
} from "@/utils/discord/ui/setupPanel";
import { SETUP_DRAFT_SCHEMA_VERSION, type SetupDraftRecord } from "@/types/discord/setupWizard";
import { initializeLocalizer } from "@/utils/text/localizer";

// `parseSetupRoute` resolves its locale segment against the loaded locale set, so a codec round trip
// reads as forged until the localizer is initialized.
await initializeLocalizer();

const LOCALE = "en-US";
const NONCE = "nonce-abc-12345";

const SETUP_ROUTES_SOURCE = readFileSync("src/utils/discord/interactions/setupRoutes.ts", "utf8");

/**
 * Actions a control or a modal actually emits, which is narrower than the set the codec declares.
 *
 * A declared action with no producer is unreachable in a client, so the two lists are compared
 * separately below rather than assumed equal.
 */
const EMITTED_ACTIONS: SetupWizardAction[] = [
  "cancel",
  "endpoint-connection",
  "endpoint-connection-submit",
  "endpoint-model",
  "endpoint-model-submit",
  "finish",
  "policies",
  "policies-submit",
  "provider-byok-submit",
  "provider-catalog-submit",
  "provider-mode",
  "settings",
  "settings-submit",
];

/** Members of the `SetupWizardAction` union, read from the declaration that defines the codec. */
function declaredActions(): string[] {
  const union = SETUP_ROUTES_SOURCE.match(/export type SetupWizardAction =([\s\S]*?);/);
  return union ? [...union[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]) : [];
}

/** Actions the dispatcher's switch handles, read from its own case labels. */
function dispatchedActions(): string[] {
  return [...SETUP_ROUTES_SOURCE.matchAll(/case "([a-z-]+)": \{/g)].map((match) => match[1]);
}

function collectRouteIds(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) collectRouteIds(child, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === "customId" || key === "custom_id") && typeof value === "string") {
      found.add(value);
    } else {
      collectRouteIds(value, found);
    }
  }
  return found;
}

function actionOf(routeId: string): SetupWizardAction | null {
  const parsed = parseInteractionRoute(routeId);
  if (!parsed || parsed.namespace !== SETUP_ROUTE_NAMESPACE || parsed.version !== SETUP_ROUTE_VERSION) return null;
  return parseSetupRoute(parsed)?.action ?? null;
}

function createDraft(overrides: Partial<SetupDraftRecord> = {}): SetupDraftRecord {
  return {
    schemaVersion: SETUP_DRAFT_SCHEMA_VERSION,
    actorDiscId: "actor-1234567890",
    workspaceKey: "workspace-1234567890",
    context: "guild",
    providerAccess: null,
    startingSettings: null,
    policiesAccepted: false,
    requiresPolicies: false,
    ...overrides,
  };
}

const CATALOGS: SetupSettingsCatalogs = {
  personas: [{ id: 7, name: "Lighthouse", description: "A steady, watchful companion." }],
  prompts: [{ name: "Tomori Default", description: "The standard reply style." }],
  promptTexts: new Map([["Tomori Default", "You are Tomori."]]),
};

/** Every control-bearing payload the wizard can render, in the states that expose each control. */
function renderedPayloads(): Array<[string, unknown]> {
  const wizard = (draft: SetupDraftRecord, isHosted: boolean) =>
    buildSetupWizardPayload({ draft, locale: LOCALE, isHosted, nonce: NONCE, settingsCatalogs: CATALOGS });

  return [
    ["pending hosted", wizard(createDraft({ requiresPolicies: true }), true)],
    ["pending non-hosted", wizard(createDraft(), false)],
    ["pending dm", wizard(createDraft({ context: "dm" }), false)],
    [
      "custom endpoint sub-area",
      wizard(
        createDraft({
          providerAccess: { mode: "custom-endpoint", connection: null, textModel: null },
        }),
        false,
      ),
    ],
    [
      "ready hosted",
      wizard(
        createDraft({
          requiresPolicies: true,
          policiesAccepted: true,
          providerAccess: { mode: "user-byok" },
          startingSettings: { presetId: 7, humanizer: 1, timezoneOffset: 0, systemPrompt: { kind: "built-in" } },
        }),
        true,
      ),
    ],
    ["catalog provider modal", buildSetupCatalogModal(LOCALE, NONCE)],
    ["endpoint connection modal", buildSetupEndpointConnectionModal(LOCALE, NONCE)],
    ["endpoint model modal", buildSetupEndpointModelModal(LOCALE, NONCE)],
    ["user byok modal", buildSetupByokModal(LOCALE, NONCE)],
    ["settings modal", buildSetupSettingsModal(LOCALE, NONCE, CATALOGS)],
    ["policies modal", buildSetupPoliciesModal(LOCALE, NONCE)],
  ];
}

/** Terminal states, which carry no control a stale press could reach. */
function terminalPayloads(): Array<[string, unknown]> {
  return [
    ["cancelled", buildSetupCancelledPayload(LOCALE)],
    ["expired", buildSetupExpiredPayload(LOCALE)],
    ["commit failed", buildSetupCommitFailedPayload(LOCALE)],
    ["commit in flight", buildSetupInFlightPayload(LOCALE)],
    [
      "receipt",
      buildSetupSuccessPayload({
        locale: LOCALE,
        context: "guild",
        providerAccess: { mode: "user-byok" },
        modelName: null,
        providerLabel: "",
        personaName: "Lighthouse",
        notes: [],
        learnMore: "Learn more",
      }),
    ],
  ];
}

/**
 * Route coverage for the `/setup` codec: every declared action round-trips, the dispatcher handles
 * every declared action, and the actions the real panels and modals emit are exactly a closed list.
 *
 * What this proves is the control surface plus build and parse agreement, so a removed control, a
 * renamed action, or an unhandled arm fails here. What it cannot prove is that every declared action
 * has a producer: `dashboard` is declared, dispatched, and emitted by no control, and asserting that
 * gap as an expected value would be a baseline entry rather than a gate. That orphan is reported to
 * the product owner for a decision (wire a control or delete the codec) rather than recorded as
 * acceptable here. If it is ever wired, `EMITTED_ACTIONS` has to grow by one and this file fails
 * until it does.
 */
describe("setup wizard route coverage", () => {
  it("declares a codec whose actions the dispatcher all handles", () => {
    const declared = declaredActions();
    expect(declared.length).toBeGreaterThanOrEqual(14);
    expect([...dispatchedActions()].sort()).toEqual([...declared].sort());
  });

  it("round-trips every declared action through its own builder and parser", () => {
    const declared = declaredActions();
    expect(declared.length).toBeGreaterThan(0);

    const routeIds = declared.map((action) => {
      return `${SETUP_ROUTE_NAMESPACE}:${SETUP_ROUTE_VERSION}:${action}:${LOCALE}:${NONCE}`;
    });

    expect(routeIds.map((routeId) => actionOf(routeId))).toEqual(declared);
  });

  it("emits exactly the actions a control or modal provides", () => {
    const routePrefix = `${SETUP_ROUTE_NAMESPACE}:${SETUP_ROUTE_VERSION}:`;
    const emitted = new Set<string>();

    for (const [label, payload] of renderedPayloads()) {
      for (const customId of collectRouteIds(payload)) {
        // A modal also carries one field ID per row, and those are the interception's own keys
        // rather than routes, so the walk only claims the IDs the registry dispatches.
        if (!customId.startsWith(routePrefix)) continue;
        const action = actionOf(customId);
        expect(`${label} ${customId} -> ${action}`).not.toContain("-> null");
        if (action) emitted.add(action);
      }
    }

    expect([...emitted].sort()).toEqual([...EMITTED_ACTIONS].sort());
  });

  it("reports a route ID that no declared action owns instead of silently dropping it", () => {
    // A negative control for the walk above: a forged ID has to come back null, or the collection
    // assertion would pass for any string a payload happened to carry.
    expect(actionOf(`${SETUP_ROUTE_NAMESPACE}:${SETUP_ROUTE_VERSION}:invented:${LOCALE}:${NONCE}`)).toBeNull();
    expect(actionOf(`other:${SETUP_ROUTE_VERSION}:settings:${LOCALE}:${NONCE}`)).toBeNull();
  });

  it("leaves every terminal state without a live control", () => {
    for (const [label, payload] of terminalPayloads()) {
      expect(`${label}: ${JSON.stringify([...collectRouteIds(payload)])}`).toBe(`${label}: []`);
    }
  });
});
