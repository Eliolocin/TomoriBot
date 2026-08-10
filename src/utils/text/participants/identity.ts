export type ParticipantKey =
  | { kind: "discord_user"; discordId: string }
  | { kind: "persona"; personaId: number }
  | { kind: "webhook"; webhookId: string }
  | { kind: "matrix_user"; matrixId: string }
  | { kind: "bot"; discordId: string };

export type ParticipantInclusionReason =
  | "visible_author"
  | "active_identity"
  | "real_mention"
  | "unique_text_alias"
  | "historical_persona"
  | "co_responder"
  | "persona_trigger_reference"
  | "bridge_presence"
  | "reminder_target";

export type ParticipantAliasPurpose =
  | "input_reference"
  | "output_mention"
  | "tool_target"
  | "copied_identity"
  | "persona_trigger";

export type ParticipantCapability = "mentionable";

export type ParticipantAliasSource =
  | "saved_nickname"
  | "effective_nickname"
  | "formatted_name"
  | "guild_display_name"
  | "guild_nickname"
  | "global_name"
  | "username"
  | "discord_id_fallback"
  | "impersonated_identity"
  | "persona_nickname"
  | "persona_trigger"
  | "bridge_display_name"
  | "webhook_display_name";

export interface ParticipantAlias {
  owner: ParticipantKey;
  value: string;
  normalized: string;
  source: ParticipantAliasSource;
  purposes: ReadonlySet<ParticipantAliasPurpose>;
  exposure: "visible" | "lookup_only";
  priority: number;
  canonicalValue?: string;
}

export interface ParticipantSeed {
  key: ParticipantKey;
  reasons: ReadonlySet<ParticipantInclusionReason>;
  aliases: readonly ParticipantAlias[];
  capabilities: ReadonlySet<ParticipantCapability>;
  firstSeenOrder: number;
  sourceDisplayName?: string;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

export function createDiscordUserKey(discordId: string): Extract<ParticipantKey, { kind: "discord_user" }> {
  return { kind: "discord_user", discordId: requireIdentifier(discordId, "Discord user ID") };
}

export function createBotKey(discordId: string): Extract<ParticipantKey, { kind: "bot" }> {
  return { kind: "bot", discordId: requireIdentifier(discordId, "Bot Discord ID") };
}

export function createWebhookKey(webhookId: string): Extract<ParticipantKey, { kind: "webhook" }> {
  return { kind: "webhook", webhookId: requireIdentifier(webhookId, "Webhook ID") };
}

export function createMatrixUserKey(matrixId: string): Extract<ParticipantKey, { kind: "matrix_user" }> {
  return { kind: "matrix_user", matrixId: requireIdentifier(matrixId, "Matrix user ID") };
}

export function createPersonaKey(personaId: number): Extract<ParticipantKey, { kind: "persona" }> {
  if (!Number.isSafeInteger(personaId) || personaId < 0) {
    throw new Error(`Persona ID must be a non-negative safe integer, received ${personaId}`);
  }
  return { kind: "persona", personaId };
}

export function serializeParticipantKey(key: ParticipantKey): string {
  switch (key.kind) {
    case "discord_user":
      return `discord_user:${key.discordId}`;
    case "persona":
      return `persona:${key.personaId}`;
    case "webhook":
      return `webhook:${key.webhookId}`;
    case "matrix_user":
      return `matrix_user:${key.matrixId}`;
    case "bot":
      return `bot:${key.discordId}`;
  }
}

export function participantKeysEqual(left: ParticipantKey, right: ParticipantKey): boolean {
  return serializeParticipantKey(left) === serializeParticipantKey(right);
}

export function mergeParticipantSeeds(seeds: readonly ParticipantSeed[]): ParticipantSeed[] {
  const mergedByKey = new Map<string, ParticipantSeed>();

  for (const seed of seeds) {
    const seedCapabilities = seed.capabilities;
    const serializedKey = serializeParticipantKey(seed.key);
    const existing = mergedByKey.get(serializedKey);
    if (!existing) {
      mergedByKey.set(serializedKey, {
        ...seed,
        reasons: new Set(seed.reasons),
        aliases: [...seed.aliases],
        capabilities: new Set(seedCapabilities),
      });
      continue;
    }

    const reasons = new Set(existing.reasons);
    for (const reason of seed.reasons) reasons.add(reason);
    const capabilities = new Set(existing.capabilities);
    for (const capability of seedCapabilities) capabilities.add(capability);
    mergedByKey.set(serializedKey, {
      ...existing,
      reasons,
      aliases: [...existing.aliases, ...seed.aliases],
      capabilities,
      firstSeenOrder: Math.min(existing.firstSeenOrder, seed.firstSeenOrder),
      sourceDisplayName: existing.sourceDisplayName ?? seed.sourceDisplayName,
    });
  }

  return [...mergedByKey.values()].sort((left, right) => left.firstSeenOrder - right.firstSeenOrder);
}
