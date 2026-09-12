import { describe, expect, it } from "bun:test";
import { compareRoots, parseDocumentedRoots } from "../../../scripts/checks/checkCommandRoots";

describe("checkCommandRoots", () => {
  it("parses documented roots from markdown section", () => {
    const markdown = [
      "# Overview",
      "",
      "## Current Top-Level Categories",
      "",
      "- `comment`",
      "- `config`",
      "- `help`",
      "",
      "## Category Restrictions",
      "- Guild-only: none",
    ].join("\n");

    expect(parseDocumentedRoots(markdown)).toEqual(["comment", "config", "help"]);
  });

  it("passes when documented roots match runtime roots exactly in order", () => {
    const roots = ["comment", "config", "help"];
    const result = compareRoots(roots, roots);

    expect(result.ok).toBe(true);
    expect(result.missingInDoc).toHaveLength(0);
    expect(result.unexpectedInDoc).toHaveLength(0);
    expect(result.outOfOrder).toBe(false);
  });

  it("detects roots missing from documentation", () => {
    const documented = ["comment", "help"];
    const runtime = ["comment", "config", "help"];
    const result = compareRoots(documented, runtime);

    expect(result.ok).toBe(false);
    expect(result.missingInDoc).toEqual(["config"]);
    expect(result.unexpectedInDoc).toHaveLength(0);
  });

  it("detects stale or extra roots documented that do not exist at runtime", () => {
    const documented = ["bot", "comment", "help"];
    const runtime = ["comment", "help"];
    const result = compareRoots(documented, runtime);

    expect(result.ok).toBe(false);
    expect(result.missingInDoc).toHaveLength(0);
    expect(result.unexpectedInDoc).toEqual(["bot"]);
  });

  it("detects out-of-order roots in documentation", () => {
    const documented = ["help", "comment", "config"];
    const runtime = ["comment", "config", "help"];
    const result = compareRoots(documented, runtime);

    expect(result.ok).toBe(false);
    expect(result.outOfOrder).toBe(true);
  });
});
