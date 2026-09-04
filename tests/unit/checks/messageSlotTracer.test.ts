/**
 * Verifies that extractMessageComponentUsages discovers known localized message component slots.
 */
import { describe, expect, it } from "bun:test";
import { extractMessageComponentUsages } from "../../../scripts/checks/checkLocalizationKeys";

describe("extractMessageComponentUsages", () => {
  it("traces known button-label slot from config panel source", async () => {
    const usages = await extractMessageComponentUsages();

    const retryUsage = usages.get("buttonLabel::commands.config.panel.retry");
    expect(retryUsage).toBeDefined();
    expect(retryUsage?.key).toBe("commands.config.panel.retry");
    expect(retryUsage?.kind).toBe("buttonLabel");
    const normalizedFiles = Array.from(retryUsage?.files ?? []).map((f) => f.replace(/\\/g, "/"));
    expect(normalizedFiles.some((f) => f.includes("utils/discord/ui/configPanel.ts"))).toBe(true);

    const placeholderUsage = usages.get("selectPlaceholder::commands.config.panel.page_select_placeholder");
    expect(placeholderUsage).toBeDefined();
    expect(placeholderUsage?.kind).toBe("selectPlaceholder");

    const optionLabelUsage = usages.get("optionLabel::commands.config.panel.on_button");
    expect(optionLabelUsage).toBeDefined();
    expect(optionLabelUsage?.kind).toBe("optionLabel");

    expect(usages.size).toBeGreaterThan(50);
  });
});
