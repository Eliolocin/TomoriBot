import { z } from "zod";
import { customEndpointApiStyleSchema, setupCustomEndpointCapabilitySchema } from "@/types/db/schema";

export const SETUP_DRAFT_SCHEMA_VERSION = 1;

export const setupDraftContextSchema = z.enum(["guild", "dm"]);
export type SetupDraftContext = z.infer<typeof setupDraftContextSchema>;

export const setupDraftEndpointConnectionSchema = z
  .object({
    label: z.string(),
    apiStyle: customEndpointApiStyleSchema,
    endpointUrl: z.string(),
    encryptedAuthToken: z.instanceof(Buffer).nullable(),
    keyVersion: z.number().int(),
  })
  .strict();
export type SetupDraftEndpointConnection = z.infer<typeof setupDraftEndpointConnectionSchema>;

export const setupDraftEndpointModelSchema = z
  .object({
    modelCode: z.string(),
    numCtx: z.number().int().nullable(),
    capabilities: z.array(setupCustomEndpointCapabilitySchema),
  })
  .strict();
export type SetupDraftEndpointModel = z.infer<typeof setupDraftEndpointModelSchema>;

export const setupDraftCatalogAccessSchema = z
  .object({
    mode: z.literal("catalog"),
    provider: z.string(),
    encryptedApiKey: z.instanceof(Buffer),
    keyVersion: z.number().int(),
  })
  .strict();
export type SetupDraftCatalogAccess = z.infer<typeof setupDraftCatalogAccessSchema>;

export const setupDraftCustomEndpointAccessSchema = z
  .object({
    mode: z.literal("custom-endpoint"),
    connection: setupDraftEndpointConnectionSchema.nullable(),
    textModel: setupDraftEndpointModelSchema.nullable(),
  })
  .strict();
export type SetupDraftCustomEndpointAccess = z.infer<typeof setupDraftCustomEndpointAccessSchema>;

export const setupDraftUserByokAccessSchema = z
  .object({
    mode: z.literal("user-byok"),
  })
  .strict();
export type SetupDraftUserByokAccess = z.infer<typeof setupDraftUserByokAccessSchema>;

export const setupDraftProviderAccessSchema = z.discriminatedUnion("mode", [
  setupDraftCatalogAccessSchema,
  setupDraftCustomEndpointAccessSchema,
  setupDraftUserByokAccessSchema,
]);
export type SetupDraftProviderAccess = z.infer<typeof setupDraftProviderAccessSchema>;
export type SetupDraftProviderMode = SetupDraftProviderAccess["mode"];

const setupDraftSystemPromptBuiltInSchema = z
  .object({
    kind: z.literal("built-in"),
  })
  .strict();

const setupDraftSystemPromptPresetSchema = z
  .object({
    kind: z.literal("preset"),
    presetName: z.string(),
  })
  .strict();

export const setupDraftSystemPromptSchema = z.discriminatedUnion("kind", [
  setupDraftSystemPromptBuiltInSchema,
  setupDraftSystemPromptPresetSchema,
]);
export type SetupDraftSystemPrompt = z.infer<typeof setupDraftSystemPromptSchema>;

export const setupDraftStartingSettingsSchema = z
  .object({
    presetId: z.number().int(),
    humanizer: z.number().int().min(0).max(3),
    timezoneOffset: z.number().int().min(-12).max(14),
    systemPrompt: setupDraftSystemPromptSchema,
  })
  .strict();
export type SetupDraftStartingSettings = z.infer<typeof setupDraftStartingSettingsSchema>;

export const setupDraftRecordSchema = z
  .object({
    schemaVersion: z.number().int(),
    actorDiscId: z.string(),
    workspaceKey: z.string(),
    context: setupDraftContextSchema,
    providerAccess: setupDraftProviderAccessSchema.nullable(),
    startingSettings: setupDraftStartingSettingsSchema.nullable(),
    policiesAccepted: z.boolean(),
    /**
     * Captured once when the draft is created, not re-read per action, so an environment flip mid-wizard cannot
     * retroactively add or remove a required step from a draft already in progress.
     */
    requiresPolicies: z.boolean(),
  })
  .strict();
export type SetupDraftRecord = z.infer<typeof setupDraftRecordSchema>;

export function isSetupDraftProviderAccessComplete(access: SetupDraftProviderAccess | null | undefined): boolean {
  if (!access) return false;
  if (access.mode === "catalog" || access.mode === "user-byok") {
    return true;
  }
  // A connection-only custom endpoint must never count as complete, because committing it would produce a
  // workspace that cannot reply.
  return access.connection !== null && access.textModel !== null;
}

export function isSetupDraftComplete(
  draft: Pick<SetupDraftRecord, "providerAccess" | "startingSettings" | "policiesAccepted" | "requiresPolicies">,
): boolean {
  if (!draft.providerAccess || !isSetupDraftProviderAccessComplete(draft.providerAccess)) {
    return false;
  }
  if (!draft.startingSettings) {
    return false;
  }
  if (draft.requiresPolicies && !draft.policiesAccepted) {
    return false;
  }
  return true;
}

/** User BYOK is guild-only: a DM has no membership for personal providers to key against. */
export function isProviderAccessAllowedInContext(mode: SetupDraftProviderMode, context: SetupDraftContext): boolean {
  return !(mode === "user-byok" && context === "dm");
}
