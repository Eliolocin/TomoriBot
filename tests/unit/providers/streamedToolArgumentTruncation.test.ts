import { describe, expect, it } from "bun:test";
import { AnthropicStreamAdapter } from "@/providers/anthropic/anthropicStreamAdapter";
import { OpenrouterStreamAdapter } from "@/providers/openrouter/openrouterStreamAdapter";
import type { ProcessedChunk, RawStreamChunk } from "@/types/stream/interfaces";

function makeChunk(provider: string, data: Record<string, unknown>): RawStreamChunk {
  return { data, provider, metadata: { timestamp: Date.now() } };
}

/** Anthropic chunks carry the SSE event name beside the decoded payload. */
function makeAnthropicChunk(eventType: string, data: Record<string, unknown>): RawStreamChunk {
  return makeChunk("anthropic", { eventType, data });
}

/**
 * Every adapter that delivers tool arguments as a stream of text deltas has to recover a
 * payload the provider cut short and mark the call, because the tool loop decides whether to
 * dispatch on that flag. A provider that only falls back to empty arguments would dispatch a
 * call the model never finished.
 */
describe("streamed tool arguments truncated mid-payload", () => {
  it("recovers OpenRouter arguments cut mid-string and marks the call", () => {
    const adapter = new OpenrouterStreamAdapter();
    const withName = adapter.processChunk(
      makeChunk("openrouter", {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "update_short_term_memory", arguments: '{"scene"' } },
              ],
            },
          },
        ],
      }),
    );
    expect(withName.type).toBe("text");

    const finished = adapter.processChunk(
      makeChunk("openrouter", {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: ': "hallway", "bodies": "Noah: coat still on',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    );

    expect(finished.type).toBe("function_call");
    expect(finished.functionCall?.args).toEqual({ scene: "hallway" });
    expect(finished.functionCall?.argumentsTruncated).toBe(true);
  });

  it("recovers Anthropic arguments cut mid-string and marks the call", () => {
    const adapter = new AnthropicStreamAdapter();
    const open = adapter.processChunk(
      makeAnthropicChunk("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "update_short_term_memory" },
      }),
    );
    expect(open.type).toBe("text");

    adapter.processChunk(
      makeAnthropicChunk("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"scene": "hallway", "bodies": "Noah: coat' },
      }),
    );

    const finished: ProcessedChunk = adapter.processChunk(makeAnthropicChunk("content_block_stop", { index: 0 }));

    expect(finished.type).toBe("function_call");
    expect(finished.functionCall?.args).toEqual({ scene: "hallway" });
    expect(finished.functionCall?.argumentsTruncated).toBe(true);
  });

  it("does not mark Anthropic arguments that parsed directly", () => {
    const adapter = new AnthropicStreamAdapter();
    adapter.processChunk(
      makeAnthropicChunk("content_block_start", {
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "echo_tool" },
      }),
    );
    adapter.processChunk(
      makeAnthropicChunk("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"text": "complete"}' },
      }),
    );

    const finished = adapter.processChunk(makeAnthropicChunk("content_block_stop", { index: 0 }));

    expect(finished.functionCall?.args).toEqual({ text: "complete" });
    expect(finished.functionCall?.argumentsTruncated).toBeUndefined();
  });
});
