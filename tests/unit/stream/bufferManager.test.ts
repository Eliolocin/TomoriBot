import { describe, expect, it } from "bun:test";
import { createDefaultStreamState } from "@/types/stream/types";
import {
  autoCloseIncompleteMarkers,
  drainThinkBlocksFromBuffer,
  hasIncompleteSemanticMarkers,
} from "@/utils/discord/stream/bufferManager";

describe("stream buffer think-block fallback", () => {
  it("routes text before a stray close tag into raw thoughts", () => {
    const state = createDefaultStreamState();
    state.buffer = "originally.</think>Bella: Eep!";

    drainThinkBlocksFromBuffer(state);

    expect(state.thoughtRawSegments).toEqual(["originally."]);
    expect(state.buffer).toBe("Bella: Eep!");
  });

  it("holds a partial close tag so a reasoning tail cannot flush visibly", () => {
    expect(hasIncompleteSemanticMarkers("originally.</thi")).toBe(true);
  });
});

/**
 * Holding the buffer suppresses newline splitting, which is what breaks a multi-message reply into
 * separate sends and lets each `Persona (sprite):` label open its own segment. An orphan ")" used to
 * count as "unbalanced", so a single emoticon deferred the whole response to the final flush: the
 * messages merged and every label after the first shipped as visible text.
 */
describe("stream buffer parenthesis balance", () => {
  it("does not hold for an emoticon's orphan closing paren", () => {
    expect(hasIncompleteSemanticMarkers("we won B)")).toBe(false);
    expect(hasIncompleteSemanticMarkers("nice :)")).toBe(false);
    expect(hasIncompleteSemanticMarkers("sneaky >:)")).toBe(false);
  });

  it("holds for a genuinely unclosed parenthetical so an aside is not split mid-way", () => {
    expect(hasIncompleteSemanticMarkers("we won (barely")).toBe(true);
  });

  it("does not hold once the parenthetical closes", () => {
    expect(hasIncompleteSemanticMarkers("we won (barely)")).toBe(false);
  });

  /**
   * The counter clamps at zero rather than banking orphan closers, so an earlier emoticon cannot
   * offset a later opener back to a balanced-looking total.
   */
  it("still holds when an emoticon precedes a genuinely unclosed parenthetical", () => {
    expect(hasIncompleteSemanticMarkers("we won :) (barely")).toBe(true);
  });

  it("closes a later parenthetical even when an emoticon contributed an orphan closer", () => {
    expect(autoCloseIncompleteMarkers("we won B) (barely")).toBe("we won B) (barely)");
  });

  it("keeps the multi-message label boundary flushable when a line ends in an emoticon", () => {
    const buffer = "@Obonya bet sending the vibes right now B)\ntomori (silly): double message combo";

    expect(hasIncompleteSemanticMarkers(buffer)).toBe(false);
  });
});
