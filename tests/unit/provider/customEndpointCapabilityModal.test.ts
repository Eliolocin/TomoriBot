import { describe, expect, it } from "bun:test";
import {
  ModalFieldId,
  WORKFLOW_UPLOAD_ID,
  buildCapabilityAddModalComponents,
  buildCapabilityEditModalComponents,
  buildImageVideoAddModalComponents,
  parseCapabilityModalFields,
} from "@/utils/provider/customEndpointCapabilityModal";
import { IMAGE_ENDPOINT_SUPPORTS_ID } from "@/utils/provider/customImageEndpointSupport";
import { formatCustomModelDisplay } from "@/utils/provider/customProviderUtils";

describe("Custom Endpoint Capability Modal & Utilities", () => {
  it("builds add modal components without display_name and with required model_name for text and embedding", () => {
    const textComponents = buildCapabilityAddModalComponents("text", "en-US");
    const textIds = textComponents.map((c) => c.customId);
    expect(textIds).toContain(ModalFieldId.model_name);
    expect(textIds).not.toContain("display_name");

    const textModel = textComponents.find((c) => c.customId === ModalFieldId.model_name);
    expect(textModel?.required).toBe(true);

    const embeddingComponents = buildCapabilityAddModalComponents("embedding", "en-US");
    const embeddingIds = embeddingComponents.map((c) => c.customId);
    expect(embeddingIds).toContain(ModalFieldId.model_name);
    expect(embeddingIds).not.toContain("display_name");

    const embeddingModel = embeddingComponents.find((c) => c.customId === ModalFieldId.model_name);
    expect(embeddingModel?.required).toBe(true);

    const speechComponents = buildCapabilityAddModalComponents("speech", "en-US");
    const speechIds = speechComponents.map((c) => c.customId);
    expect(speechIds).not.toContain("display_name");
    expect(speechIds).toContain(ModalFieldId.voice_mode);
    expect(speechIds).toContain(ModalFieldId.script_markup);

    const transcriptionComponents = buildCapabilityAddModalComponents("transcription", "en-US");
    const transcriptionIds = transcriptionComponents.map((c) => c.customId);
    expect(transcriptionIds).not.toContain("display_name");
    expect(transcriptionIds).toContain(ModalFieldId.transcription_model);
  });

  it("builds image add modal components with required model_name, workflow upload, and support component within 5 components", () => {
    const components = buildImageVideoAddModalComponents("image", "en-US", "comfyui");
    expect(components.length).toBeLessThanOrEqual(5);

    const modelField = components.find((c) => c.customId === ModalFieldId.model_name);
    expect(modelField).toBeDefined();
    expect(modelField?.required).toBe(true);

    const workflowField = components.find((c) => c.customId === WORKFLOW_UPLOAD_ID);
    expect(workflowField).toBeDefined();

    const supportField = components.find((c) => c.customId === IMAGE_ENDPOINT_SUPPORTS_ID);
    expect(supportField).toBeDefined();
  });

  it("builds video add modal components with required model_name, workflow upload, and no support component within 5 components", () => {
    const components = buildImageVideoAddModalComponents("video", "en-US", "comfyui");
    expect(components.length).toBeLessThanOrEqual(5);

    const modelField = components.find((c) => c.customId === ModalFieldId.model_name);
    expect(modelField).toBeDefined();
    expect(modelField?.required).toBe(true);

    const workflowField = components.find((c) => c.customId === WORKFLOW_UPLOAD_ID);
    expect(workflowField).toBeDefined();

    const supportField = components.find((c) => c.customId === IMAGE_ENDPOINT_SUPPORTS_ID);
    expect(supportField).toBeUndefined();
  });

  it("builds edit modal components without display_name for all capabilities", () => {
    for (const capability of ["text", "embedding", "speech", "transcription", "image", "video"] as const) {
      const components = buildCapabilityEditModalComponents(
        capability,
        "en-US",
        {
          modelName: "test-model",
          endpointUrl: "http://127.0.0.1:8000",
        },
        false,
      );
      const ids = components.map((c) => c.customId);
      expect(ids).not.toContain("display_name");
      expect(ids).toContain(ModalFieldId.endpoint_url);
    }
  });

  it("parses capability modal fields correctly without displayName", () => {
    const parsed = parseCapabilityModalFields(
      {
        [ModalFieldId.model_name]: "deepseek-v3",
        [ModalFieldId.endpoint_url]: "http://localhost:8000/v1",
      },
      {
        [ModalFieldId.text_capabilities]: ["tools", "vision"],
      },
      "text",
    );

    expect(parsed.modelName).toBe("deepseek-v3");
    expect(parsed.endpointUrl).toBe("http://localhost:8000/v1");
    expect(parsed.hasTools).toBe(true);
    expect(parsed.seesImages).toBe(true);
    expect(parsed.supportsStructOutput).toBe(false);
    expect((parsed as Record<string, unknown>).displayName).toBeUndefined();
  });

  it("formats custom endpoint model display using formatCustomModelDisplay", () => {
    expect(
      formatCustomModelDisplay({
        label: "my-endpoint",
        model_name: "llama-3",
      }),
    ).toBe("llama-3 (my-endpoint)");

    expect(
      formatCustomModelDisplay({
        label: "my-endpoint",
        model_name: null,
      }),
    ).toBe("my-endpoint (my-endpoint)");

    expect(
      formatCustomModelDisplay({
        label: "llama-3",
        model_name: "llama-3",
      }),
    ).toBe("llama-3 (llama-3)");
  });
});
