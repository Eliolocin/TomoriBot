import { describe, expect, it } from "bun:test";
import { applyDeliberateToolAllowlist, getDeliberateToolAllowedNames } from "@/utils/tools/deliberateToolMode";

describe("deliberate tool mode", () => {
  it("allows the unified web_search tool for web-search intent", () => {
    const allowedNames = getDeliberateToolAllowedNames("can you search the web for current TypeScript news?");

    expect(allowedNames).toContain("web_search");
  });

  it("keeps web_search visible after applying the deliberate allowlist", () => {
    const result = applyDeliberateToolAllowlist({
      providerLabel: "test",
      builtInTools: [{ name: "web_search" }, { name: "create_task" }],
      mcpFunctionNames: [],
      allowedToolNames: getDeliberateToolAllowedNames("look up today's AI news"),
    });

    expect(result.builtInTools.map((tool) => tool.name)).toEqual(["web_search"]);
  });

  it("allows update_task for reminder edit/delete intent", () => {
    expect(getDeliberateToolAllowedNames("cancel reminder ID:42")).toContain("update_task");
    expect(getDeliberateToolAllowedNames("reschedule that task for tomorrow")).toContain("update_task");
  });

  it("exposes create_task and update_task for reminder custom triggers", () => {
    const allowedNames = getDeliberateToolAllowedNames("scheduler please", { reminder: ["scheduler"] });

    expect(allowedNames).toContain("create_task");
    expect(allowedNames).toContain("update_task");
  });

  it("allows user blocking tools for block and unblock intent", () => {
    expect(getDeliberateToolAllowedNames("mute Alice for one hour")).toContain("block_user");
    expect(getDeliberateToolAllowedNames("remove the user block for Alice")).toContain("unblock_user");
  });

  it("exposes block_user and unblock_user for user-blocking custom triggers", () => {
    const allowedNames = getDeliberateToolAllowedNames("moderation please", {
      "user-blocking": ["moderation"],
    });

    expect(allowedNames).toContain("block_user");
    expect(allowedNames).toContain("unblock_user");
  });

  it("supports wildcard custom triggers without breaking regex triggers", () => {
    expect(getDeliberateToolAllowedNames("", { image: ["^"] })).toContain("generate_image");
    expect(
      getDeliberateToolAllowedNames("please sketch this", { image: [{ type: "regex", value: "\\bsketch\\b" }] }),
    ).toContain("generate_image");
    expect(getDeliberateToolAllowedNames("hello", { image: [{ type: "literal", value: "pic" }] })).not.toContain(
      "generate_image",
    );
  });

  it("exposes capability review and docs access for self-diagnostic questions", () => {
    const prompts = [
      "What model are you currently using?",
      "Is web search enabled for you?",
      "Why can't you generate images?",
      "Why do you forget conversations?",
      "How does TomoriBot memory work?",
    ];

    for (const prompt of prompts) {
      const allowedNames = getDeliberateToolAllowedNames(prompt);
      expect(allowedNames).toContain("review_capabilities");
      expect(allowedNames).toContain("fetch_url");
      expect(allowedNames).not.toContain("web_search");
    }
  });
});
