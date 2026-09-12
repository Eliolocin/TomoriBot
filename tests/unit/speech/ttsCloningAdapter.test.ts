import { describe, expect, it } from "bun:test";
import { buildTtsCloneRequestBody } from "@/providers/custom/styles/ttsCloningAdapter";

describe("buildTtsCloneRequestBody", () => {
  it("forwards clone instructions only when the endpoint advertises them", () => {
    const common = {
      processedScript: "Hello there",
      refAudio: Buffer.from("reference-audio"),
      refText: "Reference words",
      instruct: "speak softly",
      supportsInstruct: true,
    };

    expect(buildTtsCloneRequestBody(common)).toMatchObject({
      text: "Hello there",
      ref_audio: Buffer.from("reference-audio").toString("base64"),
      ref_text: "Reference words",
      instruct: "speak softly",
    });
    expect(buildTtsCloneRequestBody({ ...common, supportsInstruct: false })).not.toHaveProperty("instruct");
  });
});
