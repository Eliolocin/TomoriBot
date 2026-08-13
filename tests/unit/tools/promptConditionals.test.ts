import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssembledServerConfig } from "@/types/db/schema";
import type { ToolStateForContext } from "@/tools/toolRegistry";
import { DEFAULT_SYSTEM_PROMPT } from "@/utils/text/context/templates";
import { findUnsupportedPresetMacros } from "@/utils/text/stPresetEngine";
import {
  createToolPromptMacroResolver,
  type PromptCapabilityValues,
  resolvePromptCapabilityValues,
} from "@/utils/tools/toolPromptMacros";
import { renderPromptConditionals, type PromptConditionPredicate } from "@/utils/tools/promptConditionals";

const ENABLED_CAPABILITIES: PromptCapabilityValues = {
  tool_use: true,
  self_teaching: true,
  personal_memories: true,
  emoji_usage: true,
  sticker_usage: true,
  web_search: true,
  manage_message: true,
  thread_creation: true,
  image_generation: true,
  video_generation: true,
  voice_message: true,
  user_blocking: true,
  short_term_memory: true,
  time_awareness: true,
};

const TOOL_STATE = {
  server_id: "1",
  activePersonaHasElevenlabsVoice: false,
  llm: {
    llm_codename: "test",
    has_tools: true,
    sees_images: false,
    sees_videos: false,
    sees_youtube: false,
    supports_structoutput: false,
  },
  config: {
    sticker_usage_enabled: true,
    web_search_enabled: true,
    self_teaching_enabled: true,
    manage_message_enabled: true,
    imagegen_enabled: true,
    videogen_enabled: true,
    voice_message_enabled: true,
    user_blocking_enabled: true,
    thread_creation_enabled: true,
  },
} satisfies ToolStateForContext;

async function render(
  text: string,
  values: Partial<Record<`${"capability" | "tool" | "tool_family"}:${string}`, boolean>>,
): Promise<{ text: string; warnings: string[] }> {
  const warnings: string[] = [];
  const rendered = await renderPromptConditionals(text, {
    evaluate: (predicate: PromptConditionPredicate) => values[`${predicate.namespace}:${predicate.name}`],
    warn: (message) => warnings.push(message),
  });
  return { text: rendered, warnings };
}

describe("prompt conditionals", () => {
  it("selects capability and tool branches", async () => {
    const result = await render(
      "A{{if capability:self_teaching}}B{{else}}C{{/if}}{{if tool:web_search}}D{{/if}}{{if tool_family:url_fetch}}F{{/if}}E",
      {
        "capability:self_teaching": true,
        "tool:web_search": false,
        "tool_family:url_fetch": true,
      },
    );

    expect(result.text).toBe("ABFE");
    expect(result.warnings).toEqual([]);
  });

  it("supports inversion and nested blocks", async () => {
    const result = await render(
      "{{if !capability:self_teaching}}off{{else}}on{{if tool:update_long_term_memory}}+update{{/if}}{{/if}}",
      {
        "capability:self_teaching": true,
        "tool:update_long_term_memory": true,
      },
    );

    expect(result.text).toBe("on+update");
  });

  it("preserves selected branch whitespace verbatim", async () => {
    const result = await render("before\n{{if capability:web_search}}  kept\n{{/if}}after", {
      "capability:web_search": true,
    });

    expect(result.text).toBe("before\n  kept\nafter");
  });

  it("treats unknown predicates as false even when inverted", async () => {
    const result = await render("{{if !capability:not_real}}unsafe{{else}}fallback{{/if}}", {});

    expect(result.text).toBe("fallback");
    expect(result.warnings).toEqual(["Unknown prompt condition: !capability:not_real"]);
  });

  it("omits malformed and unclosed conditional blocks", async () => {
    const malformed = await render("before{{if capability:self_teaching}}hidden{{else extra}}fallback{{/if}}after", {
      "capability:self_teaching": true,
    });
    const unclosed = await render("before{{if capability:self_teaching}}hidden", {
      "capability:self_teaching": true,
    });

    expect(malformed.text).toBe("beforeafter");
    expect(malformed.warnings).toHaveLength(1);
    expect(unclosed.text).toBe("before");
    expect(unclosed.warnings).toHaveLength(1);
  });

  it("does not leave an empty paragraph where a block rendered to nothing", async () => {
    const input = "intro.\n\n{{if tool:absent}}skipped{{/if}}\n\noutro.";
    const result = await render(input, {});

    expect(result.text).toBe("intro.\n\noutro.");
  });

  it("collapses only one separator when consecutive blocks all render to nothing", async () => {
    const input = "intro.\n\n{{if tool:absent}}a{{/if}}{{if tool:absent}}b{{/if}}\n\noutro.";
    const result = await render(input, {});

    expect(result.text).toBe("intro.\n\noutro.");
  });

  it("keeps the separator when the block renders content", async () => {
    const input = "intro.\n\n{{if tool:present}}kept{{/if}}\n\noutro.";
    const result = await render(input, { "tool:present": true });

    expect(result.text).toBe("intro.\n\nkept\n\noutro.");
  });

  it("preserves authored blank lines inside a selected branch", async () => {
    const input = "{{if tool:present}}one\n\n\n\ntwo{{/if}}";
    const result = await render(input, { "tool:present": true });

    expect(result.text).toBe("one\n\n\n\ntwo");
  });

  it("leaves an inline removal alone when no blank-line separator surrounds it", async () => {
    const input = "before {{if tool:absent}}gone{{/if}} after";
    const result = await render(input, {});

    expect(result.text).toBe("before  after");
  });

  it("leaves legacy handlebars conditionals untouched", async () => {
    const input = "{{#if self_teaching}}legacy{{/if}}";
    const result = await render(input, {});

    expect(result.text).toBe(input);
  });
});

describe("prompt macro resolver condition integration", () => {
  it("keeps the migration rollback fallback synchronized", () => {
    const migration = readFileSync(
      join(process.cwd(), "src/db/migrations/061_default_system_prompt_read_time.down.sql"),
      "utf8",
    );
    const literal = migration.match(/SET system_prompt = E'((?:''|[^'])*)'\s+WHERE/s)?.[1];

    expect(literal).toBeDefined();
    expect(literal?.replaceAll("''", "'").replaceAll("\\n", "\n")).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("evaluates capability blocks before expanding surviving tool macros", async () => {
    const resolver = createToolPromptMacroResolver({ capabilities: ENABLED_CAPABILITIES });

    expect(await resolver.expand("{{if capability:self_teaching}}Use {memory_tool}.{{/if}}")).toBe(
      "Use `create_long_term_memory`.",
    );
  });

  it("removes the default memory instructions when tool use is disabled", async () => {
    const resolver = createToolPromptMacroResolver({
      capabilities: { ...ENABLED_CAPABILITIES, tool_use: false },
    });

    const expanded = await resolver.expand(DEFAULT_SYSTEM_PROMPT);

    expect(expanded).toContain("respond short and concisely");
    expect(expanded).not.toContain("memory");
    expect(expanded).not.toContain("docs.tomoribot.app");
    expect(expanded).not.toContain("review_capabilities");
    expect(expanded).not.toContain("{{if");
  });

  it("uses the scoped runtime tool set without reloading availability", async () => {
    const resolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: TOOL_STATE,
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set(["create_long_term_memory", "web_search"]),
      deliberateToolAllowedNames: ["web_search"],
    });

    const expanded = await resolver.expand(
      "{{if tool:create_long_term_memory}}memory{{else}}no-memory{{/if}}/{{if tool:web_search}}search{{/if}}",
    );

    expect(expanded).toBe("no-memory/search");
  });

  it("hides tool branches when the active model cannot call tools", async () => {
    const resolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: { ...TOOL_STATE, llm: { ...TOOL_STATE.llm, has_tools: false } },
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set(["create_long_term_memory"]),
    });

    expect(await resolver.expand("{{if tool:create_long_term_memory}}memory{{else}}none{{/if}}")).toBe("none");
  });

  it("renders and expands each default memory instruction when its tool is available", async () => {
    const resolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: TOOL_STATE,
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set(["create_long_term_memory", "update_long_term_memory"]),
    });

    const expanded = await resolver.expand(DEFAULT_SYSTEM_PROMPT);

    expect(expanded).toContain("`create_long_term_memory`");
    expect(expanded).toContain("`update_long_term_memory`");
    expect(expanded).not.toContain("{{if");
  });

  it("renders self-diagnostic guidance for bundled and guild URL fetch tools", async () => {
    const bundledResolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: TOOL_STATE,
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set([
        "create_long_term_memory",
        "update_long_term_memory",
        "review_capabilities",
        "fetch_url",
      ]),
    });
    const guildResolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: TOOL_STATE,
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set(["review_capabilities", "read_webpage"]),
    });

    const bundled = await bundledResolver.expand(DEFAULT_SYSTEM_PROMPT);
    const guild = await guildResolver.expand(DEFAULT_SYSTEM_PROMPT);

    expect(bundled).toContain("`review_capabilities`");
    expect(bundled).toContain("`fetch_url`");
    expect(bundled).toContain("https://docs.tomoribot.app/llms.txt");
    expect(bundled.indexOf("`create_long_term_memory`")).toBeLessThan(bundled.indexOf("`review_capabilities`"));
    expect(bundled).toContain("warrants it.\n\n");
    expect(guild).toContain("`read_webpage`");
    expect(guild).not.toContain("currently available URL fetch tool");
  });

  it("does not infer URL-fetch availability from unrelated read tools", async () => {
    const resolver = createToolPromptMacroResolver({
      provider: "google",
      stateForContext: TOOL_STATE,
      capabilities: ENABLED_CAPABILITIES,
      availableToolNames: new Set(["review_capabilities", "read_file"]),
    });

    const expanded = await resolver.expand(DEFAULT_SYSTEM_PROMPT);

    expect(expanded).toContain("`review_capabilities`");
    expect(expanded).not.toContain("docs.tomoribot.app");
  });

  it("maps public capability names independently from database column names", () => {
    const values = resolvePromptCapabilityValues({
      tool_use_enabled: false,
      self_teaching_enabled: false,
      personal_memories_enabled: true,
      emoji_usage_enabled: true,
      sticker_usage_enabled: false,
      web_search_enabled: true,
      manage_message_enabled: false,
      thread_creation_enabled: true,
      imagegen_enabled: false,
      videogen_enabled: true,
      voice_message_enabled: false,
      user_blocking_enabled: true,
      short_term_memory_enabled: false,
      time_awareness_enabled: true,
    } as AssembledServerConfig);

    expect(values).toMatchObject({
      tool_use: false,
      self_teaching: false,
      sticker_usage: false,
      image_generation: false,
      video_generation: true,
      short_term_memory: false,
    });
  });
});

describe("SillyTavern conditional compatibility reporting", () => {
  it("accepts TomoriBot predicates while retaining warnings for legacy blocks", () => {
    expect(
      findUnsupportedPresetMacros(
        "{{if capability:self_teaching}}memory{{else}}none{{/if}} {{if !tool:web_search}}offline{{/if}}",
      ),
    ).toEqual([]);
    expect(findUnsupportedPresetMacros("{{#if self_teaching}}legacy{{/if}}")).toContain("{{#if ...}}");
  });
});
