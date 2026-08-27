import type {
  CustomEndpointRow,
  PersonalProviderCapability,
  UserSavedProviderConfigRow,
  UserSavedProviderConfigUpsert,
} from "@/types/db/schema";
import { llmModelRepo, llmProviderRepo } from "@/utils/db/repositories";
import { prunePrimaryFallbackRefs } from "@/utils/provider/fallbackModelIdentity";

export interface ProviderModelSelection {
  model: string;
  provider: string;
}

function sortProviderRows(rows: UserSavedProviderConfigRow[]): UserSavedProviderConfigRow[] {
  return [...rows].sort((left, right) => left.provider.localeCompare(right.provider));
}

export function hasConfiguredPersonalModel(
  row: UserSavedProviderConfigRow,
  capability: PersonalProviderCapability,
): boolean {
  switch (capability) {
    case "text":
      return row.llm_id !== null;
    case "embedding":
      return row.embedding_model_id !== null;
    case "image":
      return row.diffusion_model_id !== null || row.nai_diffusion_model_id !== null;
    case "video":
      return row.video_model_id !== null;
    case "vision":
      return row.vision_llm_id !== null;
  }
}

export function getActivePersonalProviderForCapability(
  rows: UserSavedProviderConfigRow[],
  capability: PersonalProviderCapability,
): UserSavedProviderConfigRow | null {
  return (
    sortProviderRows(rows).find(
      (row) => row.enabled_capabilities.includes(capability) && hasConfiguredPersonalModel(row, capability),
    ) ?? null
  );
}

/**
 * The provider row that owns `capability`, whether or not it is switched on.
 *
 * This is what a disable must preserve: without it the owner had to be re-derived,
 * and the only available ordering was alphabetical, which silently moved a user's
 * route to whichever provider happened to sort first.
 */
export function getAssignedPersonalProviderForCapability(
  rows: UserSavedProviderConfigRow[],
  capability: PersonalProviderCapability,
): UserSavedProviderConfigRow | null {
  return sortProviderRows(rows).find((row) => row.assigned_capabilities.includes(capability)) ?? null;
}

/**
 * A provider row that could serve `capability` when none has been assigned one.
 *
 * Only reachable for a user who configured models before migration 060 backfilled
 * ownership, or who has never routed this capability personally. Picking the first
 * row by provider name is arbitrary, which is exactly why it must not be consulted
 * once an assignment exists.
 */
export function getStoredPersonalProviderForCapability(
  rows: UserSavedProviderConfigRow[],
  capability: PersonalProviderCapability,
): UserSavedProviderConfigRow | null {
  return (
    getAssignedPersonalProviderForCapability(rows, capability) ??
    sortProviderRows(rows).find((row) => hasConfiguredPersonalModel(row, capability)) ??
    null
  );
}

/**
 * Whether writing a model for `capability` would newly move it off the server default and onto a
 * personal override.
 *
 * A personal override follows the user into every server, so that transition is the one operation
 * worth confirming before the write. Switching models or providers inside an override that is
 * already active changes nothing about scope and must not prompt again.
 */
export function activatesNewPersonalOverride(
  rows: UserSavedProviderConfigRow[],
  capability: PersonalProviderCapability,
): boolean {
  return getActivePersonalProviderForCapability(rows, capability) === null;
}

/**
 * The capabilities a `toggle-models` submission moves from the server default onto a personal
 * override. Capabilities being switched off are deliberately excluded: unchecking already
 * expresses that intent through the submitted modal.
 */
export function findNewlyEnabledPersonalCapabilities(
  rows: UserSavedProviderConfigRow[],
  selected: ReadonlySet<PersonalProviderCapability>,
  capabilities: readonly PersonalProviderCapability[],
): PersonalProviderCapability[] {
  return capabilities.filter(
    (capability) => selected.has(capability) && activatesNewPersonalOverride(rows, capability),
  );
}

/**
 * Whether saving `provider` only rotates the credential behind the personal text route the user
 * is already on. The routing is unchanged, so the activation confirmation would be noise.
 */
export function isPersonalTextCredentialRotation(rows: UserSavedProviderConfigRow[], provider: string): boolean {
  return getActivePersonalProviderForCapability(rows, "text")?.provider.toLowerCase() === provider.toLowerCase();
}

/** Resolves the active personal model/provider pair(s) for a capability. */
export async function resolveActivePersonalProviderModelSelections(
  rows: UserSavedProviderConfigRow[],
  capability: PersonalProviderCapability,
): Promise<ProviderModelSelection[]> {
  const row = getActivePersonalProviderForCapability(rows, capability);
  if (!row) return [];

  switch (capability) {
    case "text": {
      const model = row.llm_id ? await llmModelRepo.loadById(row.llm_id) : null;
      return model ? [{ model: model.llm_codename, provider: row.provider }] : [];
    }
    case "embedding": {
      const model = row.embedding_model_id ? await llmModelRepo.loadEmbeddingModelById(row.embedding_model_id) : null;
      return model ? [{ model: model.codename, provider: row.provider }] : [];
    }
    case "image": {
      const modelIds = [row.diffusion_model_id, row.nai_diffusion_model_id].filter(
        (modelId): modelId is number => typeof modelId === "number",
      );
      const models = await Promise.all(modelIds.map((modelId) => llmModelRepo.loadDiffusionModelById(modelId)));
      return models.flatMap((model) => (model ? [{ model: model.codename, provider: row.provider }] : []));
    }
    case "video": {
      const model = row.video_model_id ? await llmModelRepo.loadVideoGenerationModelById(row.video_model_id) : null;
      return model ? [{ model: model.codename, provider: row.provider }] : [];
    }
    case "vision": {
      const model = row.vision_llm_id ? await llmModelRepo.loadById(row.vision_llm_id) : null;
      return model ? [{ model: model.llm_codename, provider: row.provider }] : [];
    }
  }
}

/**
 * Builds the upsert payload that promotes a text model to personal primary.
 *
 * The promoted model is pruned from the saved fallback chain: a fallback identical to the primary
 * can never run, and leaving it there makes `/personal model fallback` reject every later edit,
 * since untouched slots resubmit the stale ref.
 */
export function withPersonalTextPrimary(
  row: UserSavedProviderConfigRow,
  llmId: number | null,
  endpoints: Iterable<Pick<CustomEndpointRow, "custom_endpoint_id" | "model_ref_id">> = [],
): UserSavedProviderConfigUpsert {
  return {
    ...row,
    llm_id: llmId,
    fallback_model_refs: prunePrimaryFallbackRefs(row.fallback_model_refs, llmId, endpoints),
  };
}

/**
 * Switches `capability` on or off for `row` without disturbing who owns it.
 *
 * Enabling implies ownership, so it writes both arrays. Disabling deliberately
 * touches only `enabled_capabilities`: dropping the assignment too is what erased
 * the user's provider choice and let a later read re-derive the wrong one.
 */
export function withCapabilityEnabled(
  row: UserSavedProviderConfigRow,
  capability: PersonalProviderCapability,
  enabled: boolean,
): UserSavedProviderConfigUpsert {
  return {
    ...row,
    enabled_capabilities: enabled
      ? Array.from(new Set([...row.enabled_capabilities, capability]))
      : row.enabled_capabilities.filter((item) => item !== capability),
    assigned_capabilities: enabled
      ? Array.from(new Set([...row.assigned_capabilities, capability]))
      : row.assigned_capabilities,
  };
}

/** Removes both the on/off state and the ownership of `capability` from `row`. */
export function withCapabilityUnassigned(
  row: UserSavedProviderConfigRow,
  capability: PersonalProviderCapability,
): UserSavedProviderConfigUpsert {
  return {
    ...row,
    enabled_capabilities: row.enabled_capabilities.filter((item) => item !== capability),
    assigned_capabilities: row.assigned_capabilities.filter((item) => item !== capability),
  };
}

/** Whether `row` holds either the on/off state or the ownership of `capability`. */
function claimsCapability(row: UserSavedProviderConfigRow, capability: PersonalProviderCapability): boolean {
  return row.enabled_capabilities.includes(capability) || row.assigned_capabilities.includes(capability);
}

export async function assignPersonalCapabilityToProvider(
  userId: number,
  provider: string,
  capability: PersonalProviderCapability,
  updater: (row: UserSavedProviderConfigRow) => UserSavedProviderConfigUpsert,
): Promise<boolean> {
  const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
  if (rows.length === 0) {
    return false;
  }

  let updated = false;
  for (const row of rows) {
    if (row.provider.toLowerCase() === provider.toLowerCase()) {
      const nextRow = updater(row);
      const ok = await llmProviderRepo.upsertUserSavedProviderConfig(userId, {
        ...nextRow,
        enabled_capabilities: Array.from(new Set([...nextRow.enabled_capabilities, capability])),
        assigned_capabilities: Array.from(new Set([...nextRow.assigned_capabilities, capability])),
      });
      if (!ok) return false;
      updated = true;
      continue;
    }

    // Ownership is exclusive, so the losing rows give up the assignment as well as
    // the on/off state; otherwise two rows would claim the same capability.
    if (claimsCapability(row, capability)) {
      const ok = await llmProviderRepo.upsertUserSavedProviderConfig(userId, withCapabilityUnassigned(row, capability));
      if (!ok) return false;
    }
  }

  return updated;
}

/**
 * Switches `capability` on or off, keeping it on the provider the user assigned.
 *
 * Re-enabling resolves the target through the stored assignment, so it returns to
 * the provider that was serving the capability before it was switched off.
 */
export async function setPersonalCapabilityEnabled(
  userId: number,
  capability: PersonalProviderCapability,
  enabled: boolean,
): Promise<boolean> {
  const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
  const targetRow = getStoredPersonalProviderForCapability(rows, capability);
  if (!targetRow) {
    return false;
  }

  for (const row of rows) {
    // Disabling never reassigns, so every row keeps its assignment and only the
    // on/off state is cleared.
    if (!enabled) {
      if (row.enabled_capabilities.includes(capability)) {
        const ok = await llmProviderRepo.upsertUserSavedProviderConfig(
          userId,
          withCapabilityEnabled(row, capability, false),
        );
        if (!ok) return false;
      }
      continue;
    }

    if (row.provider.toLowerCase() === targetRow.provider.toLowerCase()) {
      const ok = await llmProviderRepo.upsertUserSavedProviderConfig(
        userId,
        withCapabilityEnabled(row, capability, true),
      );
      if (!ok) return false;
      continue;
    }

    if (claimsCapability(row, capability)) {
      const ok = await llmProviderRepo.upsertUserSavedProviderConfig(userId, withCapabilityUnassigned(row, capability));
      if (!ok) return false;
    }
  }

  return true;
}

export async function loadActivePersonalTextProvider(userId: number): Promise<UserSavedProviderConfigRow | null> {
  const rows = await llmProviderRepo.loadUserSavedProviderConfigs(userId);
  return getActivePersonalProviderForCapability(rows, "text");
}

export async function loadPersonalProviderOrNull(
  userId: number,
  provider: string,
): Promise<UserSavedProviderConfigRow | null> {
  return await llmProviderRepo.loadUserSavedProviderConfig(userId, provider);
}
