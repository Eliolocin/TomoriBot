import type { Guild } from "discord.js";
import type { PersonaSpriteRow, TomoriState } from "@/types/db/schema";
import { ContextItemTag, type ConversationUserReference } from "@/types/misc/context";
import type { StreamContext } from "@/types/stream/interfaces";
import type { SpriteMessageRecordInfo } from "@/types/stream/types";
import type { ResolvedWebhookIdentity } from "@/utils/discord/webhook/identity";
import { getCachedPersonaSprites } from "@/utils/cache/personaSpriteCache";
import { getCachedAllPersonas } from "@/utils/cache/tomoriStateCache";
import { resolveImpersonatedIdentity } from "@/utils/chat/webhookIdentity";
import { formatRenderModifierWebhookName, normalizeRenderModifierName } from "@/utils/discord/renderModifierParser";
import { resolvePersonaWebhookIdentity } from "@/utils/discord/webhook/identity";
import { log } from "@/utils/misc/logger";
import { normalizePersonaSpriteKey } from "@/utils/persona/sprites";
import { collectParticipantTargetIndex, targetAliasesForPurpose } from "@/utils/text/participants/targetIndex";
import {
  isLocalPersonaAvatarPath,
  loadStoredPersonaAvatarDataUri,
  resolvePersonaAvatarPublicUrl,
} from "@/utils/storage/avatarStorage";

type CopiedRenderCandidate =
  | {
      kind: "persona";
      key: string;
      displayName: string;
      persona: TomoriState;
    }
  | {
      kind: "user";
      key: string;
      displayName: string;
      aliases: string[];
      userId: string;
    };

export type CopiedRenderTarget = {
  displayName: string;
  identity: ResolvedWebhookIdentity;
  /**
   * Decorated "Name (modifier)" label recorded in accumulated text so the model
   * sees its own modifier usage. For sprites this differs from the webhook
   * username, which stays the clean persona name.
   */
  contextLabel: string;
  /** Present for sprite targets: persisted after send for context label recovery. */
  spriteRecord?: SpriteMessageRecordInfo;
  /**
   * True only for identity sprites. Identity sprites already use a distinct
   * decorated "Sprite (Persona)" webhook name, so the zero-width group-break
   * marker (applied to clean-named non-identity sprites) must not be appended, so
   * a trailing marker would break the decorated-name round-trip in
   * resolveRenderModifierSourcePersona.
   */
  isIdentitySprite?: boolean;
};

export type SpriteRenderModifierResolution =
  | { status: "not_found" }
  | {
      status: "matched";
      target: CopiedRenderTarget | null;
    };

function getStreamGuild(context: StreamContext): Guild | null {
  return (context.channel as { guild?: Guild | null }).guild ?? null;
}

function isDiscordSnowflake(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}

function getConversationUserReferences(context: StreamContext): ConversationUserReference[] {
  const references: ConversationUserReference[] = [];
  for (const item of context.contextItems) {
    if (item.metadataTag !== ContextItemTag.KNOWLEDGE_USERS_IN_CONVERSATION || !item.conversationUsers?.length) {
      continue;
    }
    references.push(...item.conversationUsers);
  }
  return references;
}

function candidateMatches(candidate: CopiedRenderCandidate, normalizedModifier: string): boolean {
  if (normalizeRenderModifierName(candidate.displayName) === normalizedModifier) {
    return true;
  }

  if (candidate.kind === "persona") {
    return normalizeRenderModifierName(candidate.persona.persona_nickname) === normalizedModifier;
  }

  return candidate.aliases.some((alias) => normalizeRenderModifierName(alias) === normalizedModifier);
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function resolveSpriteIdentity(
  sprite: PersonaSpriteRow,
  webhookUsername: string,
): Promise<ResolvedWebhookIdentity | null> {
  // The webhook username is decided by the caller: ordinary sprites use the clean
  // persona name (and recover "Name (sprite):" from persona_sprite_messages during
  // context rebuilding), while identity sprites show the decorated "Sprite (Name)"
  // label directly in Discord like a DID alter / copied identity.
  const username = webhookUsername.trim() || "Persona";
  const avatarReference = sprite.avatar_url.trim();
  const publicAvatarUrl = resolvePersonaAvatarPublicUrl(avatarReference);
  if (publicAvatarUrl && isValidHttpUrl(publicAvatarUrl)) {
    return {
      username,
      avatarUrl: publicAvatarUrl,
    };
  }

  if (isLocalPersonaAvatarPath(avatarReference)) {
    const avatarDataUri = await loadStoredPersonaAvatarDataUri(avatarReference);
    if (avatarDataUri) {
      return {
        username,
        avatarDataUri,
      };
    }
  }

  if (isValidHttpUrl(avatarReference)) {
    return {
      username,
      avatarUrl: avatarReference,
    };
  }

  log.warn(`Persona sprite ${sprite.sprite_id ?? "unknown"} for persona ${sprite.persona_id} has no usable avatar`);
  return null;
}

function addCandidate(candidatesByKey: Map<string, CopiedRenderCandidate>, candidate: CopiedRenderCandidate): void {
  if (!candidatesByKey.has(candidate.key)) {
    candidatesByKey.set(candidate.key, candidate);
  }
}

async function collectCopiedRenderCandidates(context: StreamContext): Promise<CopiedRenderCandidate[]> {
  const guild = getStreamGuild(context);
  if (!guild) {
    return [];
  }

  const candidatesByKey = new Map<string, CopiedRenderCandidate>();
  const personas = await getCachedAllPersonas(guild.id).catch((error) => {
    log.warn(`Failed to load personas while resolving render modifier in guild ${guild.id}`, error);
    return [];
  });

  const targetIndex = collectParticipantTargetIndex(context.contextItems);
  if (targetIndex.targets.length > 0) {
    const personasById = new Map(
      personas.flatMap((persona) =>
        typeof persona.persona_id === "number" ? [[persona.persona_id, persona] as const] : [],
      ),
    );
    for (const target of targetIndex.targets) {
      const copiedAliases = targetAliasesForPurpose(target, "copied_identity").map((alias) => alias.value);
      if (copiedAliases.length === 0) continue;
      if (target.key.kind === "persona") {
        if (target.key.personaId === context.tomoriState.persona_id) continue;
        const persona = personasById.get(target.key.personaId);
        if (!persona) continue;
        addCandidate(candidatesByKey, {
          kind: "persona",
          key: target.serializedKey,
          displayName: target.displayLabel,
          persona,
        });
        continue;
      }
      if (
        target.key.kind === "discord_user" &&
        target.inParticipantContext &&
        target.targetId &&
        isDiscordSnowflake(target.targetId)
      ) {
        addCandidate(candidatesByKey, {
          kind: "user",
          key: target.serializedKey,
          displayName: target.displayLabel,
          aliases: copiedAliases,
          userId: target.targetId,
        });
      }
    }
    if (!targetIndex.personaCatalogComplete) {
      for (const persona of personas) {
        if (persona.persona_id == null || persona.persona_id === context.tomoriState.persona_id) continue;
        addCandidate(candidatesByKey, {
          kind: "persona",
          key: `persona:${persona.persona_id}`,
          displayName: persona.persona_nickname,
          persona,
        });
      }
    }
    return [...candidatesByKey.values()];
  }

  for (const persona of personas) {
    if (persona.persona_id == null || persona.persona_id === context.tomoriState.persona_id) {
      continue;
    }
    addCandidate(candidatesByKey, {
      kind: "persona",
      key: `persona:${persona.persona_id}`,
      displayName: persona.persona_nickname,
      persona,
    });
  }

  for (const reference of getConversationUserReferences(context)) {
    if (!isDiscordSnowflake(reference.targetId)) {
      continue;
    }

    addCandidate(candidatesByKey, {
      kind: "user",
      key: `user:${reference.targetId}`,
      displayName: reference.displayLabel,
      aliases: reference.aliases,
      userId: reference.targetId,
    });
  }

  return [...candidatesByKey.values()];
}

/**
 * Collects every speaker name the model could plausibly leak as a turn label: other personas in
 * the guild (nickname) and users referenced in the conversation (display label + aliases). The
 * active persona is excluded (collectCopiedRenderCandidates skips it), since its labels are
 * handled by the render-modifier parse and own-name stripping.
 *
 * Used by the stream segment processor's opening-label leak guard to decide whether a plain
 * "Name:" opening is a known participant (a leak) or ordinary prose ("Note:", "TL;DR:").
 *
 * @param context - Active stream context (provides guild + conversation user references)
 * @returns Known speaker names, un-normalized (callers compare via matchesRenderModifierName)
 */
export async function collectKnownSpeakerNames(context: StreamContext): Promise<string[]> {
  const names: string[] = [];
  for (const candidate of await collectCopiedRenderCandidates(context)) {
    names.push(candidate.displayName);
    if (candidate.kind === "user") {
      names.push(...candidate.aliases);
    } else {
      names.push(candidate.persona.persona_nickname);
    }
  }
  return names;
}

export async function resolveCopiedRenderModifierTarget(
  modifier: string,
  context: StreamContext,
  sourceDisplayName: string,
): Promise<CopiedRenderTarget | null> {
  const normalizedModifier = normalizeRenderModifierName(modifier);
  if (!normalizedModifier) {
    return null;
  }

  const candidates = (await collectCopiedRenderCandidates(context)).filter((candidate) =>
    candidateMatches(candidate, normalizedModifier),
  );

  if (candidates.length !== 1) {
    return null;
  }

  const [candidate] = candidates;
  // Discord shows the impersonated name first ("bredrumb (Ren)") so the
  // disguise reads naturally in chat; the model-facing label keeps the source
  // persona first ("Ren (bredrumb)") so the LLM never confuses who is speaking.
  // resolveRenderModifierSourcePersona reconstructs the source persona from
  // either orientation when rebuilding context from webhook names.
  const username = formatRenderModifierWebhookName(candidate.displayName, sourceDisplayName);
  const contextLabel = formatRenderModifierWebhookName(sourceDisplayName, candidate.displayName);
  if (candidate.kind === "persona") {
    const guild = getStreamGuild(context);
    if (!guild) return null;

    const personaIdentity = await resolvePersonaWebhookIdentity(candidate.persona, guild);
    return {
      displayName: candidate.displayName,
      identity: {
        username,
        avatarUrl: personaIdentity.avatarUrl,
        avatarDataUri: personaIdentity.avatarDataUri,
      },
      contextLabel,
    };
  }

  const userIdentity = await resolveImpersonatedIdentity(
    context.client,
    getStreamGuild(context),
    candidate.userId,
    candidate.displayName,
  );
  return {
    displayName: candidate.displayName,
    identity: {
      username,
      avatarUrl: userIdentity.avatarUrl,
    },
    contextLabel,
  };
}

export async function resolveSpriteRenderModifierTarget(
  modifier: string,
  context: StreamContext,
  sourceDisplayName: string,
): Promise<SpriteRenderModifierResolution> {
  const personaId = context.tomoriState.persona_id;
  if (typeof personaId !== "number") {
    return { status: "not_found" };
  }

  const spriteKey = normalizePersonaSpriteKey(modifier);
  if (!spriteKey) {
    return { status: "not_found" };
  }

  const sprites = await getCachedPersonaSprites(personaId).catch((error) => {
    log.warn(`Failed to load persona sprites while resolving render modifier for persona ${personaId}`, error);
    return [];
  });
  const sprite = sprites.find((candidate) => candidate.sprite_key === spriteKey);
  if (!sprite) {
    return { status: "not_found" };
  }

  // Identity sprites render the decorated "Sprite (Persona)" name in Discord (the
  // disguise reads naturally, like copied identities); ordinary sprites keep the
  // clean persona name. The model-facing contextLabel stays "Persona (Sprite)"
  // either way, and the decorated webhook name still recovers to the source
  // persona via resolveRenderModifierSourcePersona during context rebuilding.
  const webhookUsername = sprite.is_identity
    ? formatRenderModifierWebhookName(sprite.sprite_name, sourceDisplayName)
    : sourceDisplayName;
  const identity = await resolveSpriteIdentity(sprite, webhookUsername);
  return {
    status: "matched",
    target: identity
      ? {
          displayName: sprite.sprite_name,
          identity,
          contextLabel: formatRenderModifierWebhookName(sourceDisplayName, sprite.sprite_name),
          spriteRecord: {
            personaId,
            spriteName: sprite.sprite_name,
            isIdentity: sprite.is_identity,
          },
          isIdentitySprite: sprite.is_identity,
        }
      : null,
  };
}
