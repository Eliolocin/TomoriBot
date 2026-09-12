import { describe, expect, it, mock } from "bun:test";
import { assembleToolsForContext } from "@/tools/assembly";
import { buildGenerateImageToolVariant, GenerateImageTool } from "@/tools/functionCalls/generateImageTool";
import type { ImageToolCapabilities } from "@/tools/functionCalls/generateImageToolCapabilities";
import { buildVoiceMessageToolVariant, GenerateVoiceMessageTool } from "@/tools/functionCalls/generateVoiceMessageTool";
import { buildWebSearchToolVariant, WebSearchTool } from "@/tools/webSearch/webSearchTool";
import type { SearchCategory } from "@/tools/webSearch/types";
import type { Tool, ToolAssemblyContext, ToolAssemblyState, ToolResult } from "@/types/tool/interfaces";
import type { CustomEndpointRow } from "@/types/db/schema";
import * as realSpeechEndpointResolver from "@/utils/provider/speechEndpointResolver";
import { createScopedModuleMocker } from "../../helpers/mockSurface";

const scopedMock = createScopedModuleMocker(mock, {
  "@/utils/provider/speechEndpointResolver": realSpeechEndpointResolver,
});

scopedMock.module("@/utils/provider/speechEndpointResolver", () => ({
  ...realSpeechEndpointResolver,
  resolveActiveSpeechEndpoint: async () => ({
    endpoint: {
      api_style: "tts-clone",
      endpoint_url: "http://127.0.0.1:8016",
      extra_config: { voice_mode: "clone", script_markup: "plain", supports_instruct: true },
    } as unknown as CustomEndpointRow,
    apiKey: "",
  }),
}));

function createAssemblyState(overrides: Partial<ToolAssemblyState> = {}): ToolAssemblyState {
  return {
    server_id: "1",
    activePersonaHasElevenlabsVoice: true,
    activePersonaVoiceDesignPrompt: null,
    activePersonaVoiceName: null,
    diffusion_model_id: 1,
    nai_diffusion_model_id: null,
    video_model_id: null,
    llm: {
      llm_codename: "test-model",
      has_tools: true,
      sees_images: true,
      sees_videos: false,
      sees_youtube: false,
      supports_structoutput: true,
    },
    config: {
      sticker_usage_enabled: true,
      web_search_enabled: true,
      self_teaching_enabled: true,
      manage_message_enabled: true,
      imagegen_enabled: true,
      videogen_enabled: true,
      voice_message_enabled: true,
      thread_creation_enabled: true,
    },
    ...overrides,
  };
}

function createAssemblyContext(state: ToolAssemblyState = createAssemblyState()): ToolAssemblyContext {
  return {
    provider: "google",
    state,
  };
}

function createStaticTool(): Tool {
  return {
    name: "static_tool",
    description: "Static tool",
    category: "utility",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    execute: async (): Promise<ToolResult> => ({ success: true }),
    isAvailableFor: () => true,
  };
}

function getEnum(tool: Tool, parameterName: string): string[] {
  const parameter = tool.parameters.properties[parameterName];
  return parameter.enum ?? [];
}

function getPropertyNames(tool: Tool): string[] {
  return Object.keys(tool.parameters.properties).sort();
}

describe("tool schema assembly", () => {
  it("leaves tools without an assembly hook unchanged", async () => {
    const tool = createStaticTool();

    const assembledTools = await assembleToolsForContext([tool], createAssemblyContext());

    expect(assembledTools).toHaveLength(1);
    expect(assembledTools[0]).toBe(tool);
  });

  it("assembles web_search with SearXNG categories", () => {
    const tool = buildWebSearchToolVariant(new WebSearchTool(), {
      categories: ["text", "image", "video", "news", "science", "it", "files", "music"],
      engineLabel: "SearXNG",
    });

    expect(tool).not.toBeNull();
    expect(getEnum(tool as Tool, "category")).toEqual([
      "text",
      "image",
      "video",
      "news",
      "science",
      "it",
      "files",
      "music",
    ]);
    expect((tool as Tool).description).not.toContain("may be unavailable");
  });

  it("assembles web_search with Brave categories", () => {
    const categories: SearchCategory[] = ["text", "image", "video", "news"];
    const tool = buildWebSearchToolVariant(new WebSearchTool(), {
      categories,
      engineLabel: "Brave Search",
    });

    expect(getEnum(tool as Tool, "category")).toEqual(categories);
  });

  it("assembles web_search with text-only fallback categories", () => {
    const tool = buildWebSearchToolVariant(new WebSearchTool(), {
      categories: ["text"],
      engineLabel: "DuckDuckGo MCP",
    });

    expect(getEnum(tool as Tool, "category")).toEqual(["text"]);
    expect(tool?.parameters.properties.category.description).toContain("Only 'text'");
  });

  it("omits web_search when no backend categories are available", () => {
    const tool = buildWebSearchToolVariant(new WebSearchTool(), null);

    expect(tool).toBeNull();
  });

  it("assembles generate_image as text-to-image only", () => {
    const capabilities: ImageToolCapabilities = {
      textToImage: true,
      imageToImage: false,
      inpaint: false,
      outpaint: false,
      negativePrompt: false,
      sourceLabel: "Z.ai",
    };

    const tool = buildGenerateImageToolVariant(new GenerateImageTool(), capabilities);

    expect(getPropertyNames(tool as Tool)).toEqual(["aspect_ratio", "prompt"]);
    expect((tool as Tool).description).toContain("text-to-image");
    // Prompt guidance must not reference modes the backend cannot perform
    const promptDescription = (tool as Tool).parameters.properties.prompt.description;
    expect(promptDescription).not.toContain("inpaint");
    expect(promptDescription).not.toContain("outpaint");
  });

  it("assembles generate_image with image-to-image reference fields", () => {
    const capabilities: ImageToolCapabilities = {
      textToImage: true,
      imageToImage: true,
      inpaint: false,
      outpaint: false,
      negativePrompt: false,
      sourceLabel: "Google",
    };

    const tool = buildGenerateImageToolVariant(new GenerateImageTool(), capabilities);

    expect(getPropertyNames(tool as Tool)).toContain("media_id");
    expect(getPropertyNames(tool as Tool)).toContain("target_identity");
    expect(getPropertyNames(tool as Tool)).not.toContain("mask_prompt");
    expect(getPropertyNames(tool as Tool)).not.toContain("outpaint");
    // media_id/denoise/prompt guidance should mention img2img only; no inpaint/outpaint
    const properties = (tool as Tool).parameters.properties;
    expect(properties.media_id.description).toBe("Reference media ID such as media_1. Use for img2img.");
    expect(properties.denoise.description).toBe("Img2img strength from 0 to 1. Lower preserves more.");
    expect(properties.prompt.description).not.toContain("inpaint");
    expect(properties.prompt.description).not.toContain("outpaint");
  });

  it("assembles generate_image with inpainting and outpainting fields", () => {
    const capabilities: ImageToolCapabilities = {
      textToImage: true,
      imageToImage: true,
      inpaint: true,
      outpaint: true,
      negativePrompt: true,
      sourceLabel: "ComfyUI",
    };

    const tool = buildGenerateImageToolVariant(new GenerateImageTool(), capabilities);
    const propertyNames = getPropertyNames(tool as Tool);

    expect(propertyNames).toContain("mask_prompt");
    expect(propertyNames).toContain("inpaint_preset");
    expect(propertyNames).toContain("outpaint");
    expect(propertyNames).toContain("outpaint_amount");
    // Full-capability backend should surface all mode guidance
    const properties = (tool as Tool).parameters.properties;
    expect(properties.prompt.description).toContain("For inpaint");
    expect(properties.prompt.description).toContain("For outpaint");
    expect(properties.media_id.description).toBe(
      "Reference media ID such as media_1. Use for img2img, inpaint, or outpaint.",
    );
    expect(properties.denoise.description).toBe("Img2img/inpaint strength from 0 to 1. Lower preserves more.");
  });

  it("omits generate_image when no image modes are supported", () => {
    const tool = buildGenerateImageToolVariant(new GenerateImageTool(), {
      textToImage: false,
      imageToImage: false,
      inpaint: false,
      outpaint: false,
      negativePrompt: false,
      sourceLabel: "disabled",
    });

    expect(tool).toBeNull();
  });

  it("assembles generate_voice_message without voice-design fields by default", () => {
    const tool = buildVoiceMessageToolVariant(new GenerateVoiceMessageTool(), "plain");

    expect(getPropertyNames(tool)).toEqual(["script", "title"]);
    expect(tool.parameters.properties.script.description).toContain("Plain text only");
  });

  it("assembles generate_voice_message with voice-design instructions", () => {
    const tool = buildVoiceMessageToolVariant(new GenerateVoiceMessageTool(), "voice-design");

    expect(getPropertyNames(tool)).toEqual(["script", "title", "voice_instructions"]);
    expect(tool.description).toContain("voice design prompt");
  });

  it("assembles generate_voice_message with clone instructions when the endpoint advertises them", () => {
    const tool = buildVoiceMessageToolVariant(new GenerateVoiceMessageTool(), "plain", {
      voiceInstructionsAvailable: true,
    });

    expect(getPropertyNames(tool)).toEqual(["script", "title", "voice_instructions"]);
    expect(tool.parameters.properties.voice_instructions?.description).toContain("one-off delivery");
  });

  it("assembles clone instructions from the active endpoint capability", async () => {
    const assembled = await assembleToolsForContext([new GenerateVoiceMessageTool()], createAssemblyContext());
    const tool = assembled[0];

    expect(tool).toBeDefined();
    expect(getPropertyNames(tool as Tool)).toContain("voice_instructions");
  });
});
