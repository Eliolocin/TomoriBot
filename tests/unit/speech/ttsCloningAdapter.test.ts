import { describe, expect, it, mock } from "bun:test";
import type { CustomEndpointRow } from "@/types/db/schema";
import * as realUserRemoteFetch from "@/utils/security/userRemoteFetch";
import { synthesizeSpeechViaTtsCloneBuffer } from "@/providers/custom/styles/ttsCloningAdapter";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

let requestBody: Record<string, unknown> | null = null;
const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
  requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(Buffer.from("audio"), { headers: { "content-type": "audio/wav" } });
});

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/security/userRemoteFetch": realUserRemoteFetch,
});

scopedMock.module("@/utils/security/userRemoteFetch", () => ({
  ...realUserRemoteFetch,
  fetchUserRemoteUrl: fetchMock,
}));

const COSYVOICE3_ENDPOINT = {
  label: "CosyVoice 3",
  api_style: "tts-clone",
  endpoint_url: "https://cosyvoice.example.test",
  extra_config: {
    script_markup: "plain",
    supports_instruct: true,
  },
} as unknown as CustomEndpointRow;

describe("CosyVoice 3 clone adapter contract", () => {
  it("maps generic voice instructions to the sidecar instruct field", async () => {
    requestBody = null;

    const result = await synthesizeSpeechViaTtsCloneBuffer({
      endpoint: COSYVOICE3_ENDPOINT,
      refAudio: Buffer.from("reference-audio"),
      refText: "Reference words",
      script: "[happy] Hello there",
      apiKey: "",
      voiceInstructions: "  speak softly  ",
    });

    expect(result.success).toBe(true);
    expect(requestBody).toMatchObject({
      text: "Hello there",
      ref_audio: Buffer.from("reference-audio").toString("base64"),
      ref_text: "Reference words",
      instruct: "speak softly",
    });
  });
});
