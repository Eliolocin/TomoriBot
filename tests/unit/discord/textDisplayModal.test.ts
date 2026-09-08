import { describe, expect, it } from "bun:test";
import { buildTextDisplayModal, buildTextDisplayModalButton } from "@/utils/discord/textDisplayModal";

describe("text display modal", () => {
  it("preserves text exactly in one large display component", () => {
    const content = "First line\n\n- [Policy](https://example.com/policy)";
    const modal = buildTextDisplayModal({ customId: "legal_text", title: "Privacy Policy", content }).toJSON();

    expect(modal.title).toBe("Privacy Policy");
    expect(modal.components).toHaveLength(1);
    expect(modal.components[0]).toMatchObject({ type: 10, content });
  });

  it("splits long copy without dropping or changing characters", () => {
    const content = "a".repeat(4_001);
    const modal = buildTextDisplayModal({ customId: "long_text", title: "Long text", content }).toJSON();
    const reconstructed = modal.components
      .map((component) => ("content" in component ? component.content : ""))
      .join("");

    expect(modal.components).toHaveLength(2);
    expect(reconstructed).toBe(content);
  });

  it("builds a simple secondary trigger button", () => {
    const row = buildTextDisplayModalButton("tips", "What You Can Do").toJSON();

    expect(row.components[0]).toMatchObject({
      custom_id: "tips",
      label: "What You Can Do",
      style: 2,
      type: 2,
    });
  });
});
