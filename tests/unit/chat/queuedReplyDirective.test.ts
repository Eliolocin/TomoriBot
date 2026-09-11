import { describe, expect, test } from "bun:test";
import { Collection, type Message } from "discord.js";
import type { PersonaSpriteRow } from "@/types/db/schema";
import { buildQueuedReplyDirective } from "@/utils/chat/contextDirectives";
import { buildPersonaSpritePromptText } from "@/utils/text/context/personaSprites";

/**
 * Build a minimal queued message. Only the fields read by `buildQueuedReplyDirective`
 * are populated (id, content, attachments, stickers); the rest is cast away.
 */
function makeQueuedMessage(content: string): Message {
  return {
    id: "1531509478955155539",
    content,
    cleanContent: content,
    attachments: new Collection<string, unknown>(),
    stickers: new Collection<string, unknown>(),
  } as unknown as Message;
}

function makeSprite(spriteName: string): PersonaSpriteRow {
  return {
    sprite_name: spriteName,
    sprite_key: spriteName.toLowerCase(),
    usage_instructions: "Use when flustered.",
    avatar_url: "https://example.invalid/sprite.png",
    is_identity: false,
    persona_id: 1,
  } as unknown as PersonaSpriteRow;
}

describe("buildQueuedReplyDirective", () => {
  test("anchors to the bare persona label when the turn carries no sprite prompt", () => {
    const directive = buildQueuedReplyDirective(makeQueuedMessage("you kinda smell ngl"), "Obonya", "Ellen");

    expect(directive).toContain('Start your next reply with "Ellen:"');
    // Advertising a sprite form on a turn without the sprite prompt would invite
    // invented sprite keys that can never resolve.
    expect(directive).not.toContain("sprite");
  });

  test("offers the sprite opening form when the sprite prompt is present", () => {
    const directive = buildQueuedReplyDirective(
      makeQueuedMessage("you kinda smell ngl"),
      "Obonya",
      "Ellen",
      undefined,
      true,
    );

    expect(directive).toContain('Start your next reply with "Ellen:"');
    expect(directive).toContain('"Ellen ({sprite label}):"');
  });

  test("still names the reply target and quotes the queued message", () => {
    const directive = buildQueuedReplyDirective(
      makeQueuedMessage("i kinda like your smell tho"),
      "Obonya",
      "Ellen",
      undefined,
      true,
    );

    expect(directive).toContain("Create a reply as Ellen to Obonya's message");
    expect(directive).toContain("i kinda like your smell tho");
  });

  /**
   * Drift guard. The queued-reply directive and the persona-sprite prompt are built in
   * separate modules but land in the same system context and describe the same opening
   * line. When they disagreed, the model obeyed the directive and silently dropped the
   * sprite tag on every queued turn. Asserting both emit byte-identical label grammar
   * makes any future reword of one side fail here instead of in production.
   */
  test("sprite label grammar matches the persona-sprite prompt exactly", () => {
    const botName = "Ellen";
    const spritePrompt = buildPersonaSpritePromptText(botName, [makeSprite("shy")]);
    const directive = buildQueuedReplyDirective(makeQueuedMessage("mwah"), "Obonya", botName, undefined, true);

    const sharedLabelGrammar = `${botName} ({sprite label}):`;
    expect(spritePrompt).toContain(sharedLabelGrammar);
    expect(directive).toContain(sharedLabelGrammar);
  });
});
