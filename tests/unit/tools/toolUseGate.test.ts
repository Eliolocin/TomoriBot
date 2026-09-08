import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TomoriState } from "@/types/db/schema";
import { resolveToolsEnabled } from "@/utils/tools/toolUseGate";

function makeState(toolUseEnabled: boolean, hasTools: boolean): TomoriState {
  return {
    llm: { llm_id: 1, llm_provider: "openrouter", llm_codename: "deepseek/deepseek-v4-flash", has_tools: hasTools },
    config: { tool_use_enabled: toolUseEnabled },
  } as TomoriState;
}

describe("resolveToolsEnabled", () => {
  it("attaches tools when nothing has disabled them", () => {
    expect(resolveToolsEnabled(makeState(true, true), true)).toBe(true);
  });

  it("refuses a provider capability catalog that contradicts the master toggle", () => {
    // OpenRouter reports the live catalog verdict, which for a tool-capable model is true even
    // though the workspace switched Tool Use off.
    expect(resolveToolsEnabled(makeState(false, false), true)).toBe(false);
  });

  it("refuses a catalog verdict that contradicts an already narrowed flag", () => {
    // Deliberate Tool Mode's kill switch narrows has_tools in place and emits no other signal,
    // so a widening override would silently revive the tools it withdrew.
    expect(resolveToolsEnabled(makeState(true, false), true)).toBe(false);
  });

  it("lets a provider withdraw tools the catalog says are unavailable", () => {
    expect(resolveToolsEnabled(makeState(true, true), false)).toBe(false);
  });

  it("treats an unset master toggle as enabled", () => {
    const state = { llm: { has_tools: true }, config: {} } as TomoriState;

    expect(resolveToolsEnabled(state, true)).toBe(true);
  });
});

/**
 * A provider that gates tool attachment on the raw flag cannot see either pipeline narrowing once
 * it holds a capability override, which is exactly how OpenRouter leaked tools past the master
 * toggle. Scanning source keeps that closed for providers added later, since a new provider file
 * is the only place the bypass can reappear.
 */
describe("provider tool gates", () => {
  const providersDir = join(import.meta.dir, "../../../src/providers");

  const providerSources = readdirSync(providersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(providersDir, entry.name);
      return readdirSync(dir)
        .filter((file) => file.endsWith(".ts"))
        .map((file) => ({ path: `${entry.name}/${file}`, content: readFileSync(join(dir, file), "utf8") }));
    });

  it("finds the provider sources it claims to scan", () => {
    expect(providerSources.length).toBeGreaterThan(20);
  });

  it("gates every tool decision through the resolver rather than the raw flag", () => {
    const offenders = providerSources.flatMap(({ path, content }) =>
      content
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(
          ({ line }) =>
            /^\s*(\}\s*else\s*)?if\s*\(/.test(line) &&
            /\.llm\.has_tools/.test(line) &&
            !line.includes("resolveToolsEnabled"),
        )
        .map(({ lineNumber }) => `${path}:${lineNumber}`),
    );

    expect(offenders).toEqual([]);
  });
});
