import { describe, expect, it } from "bun:test";
import { ButtonStyle, ComponentType } from "discord.js";
import { buildStateControlRow, type StateControlChoice } from "@/utils/discord/ui/panel";

describe("buildStateControlRow", () => {
  const booleanChoices: readonly StateControlChoice<boolean>[] = [
    { value: false, label: "Personal Providers Required", customId: "mod:set:false" },
    { value: true, label: "Server Models Allowed", customId: "mod:set:true" },
  ];

  it("renders selected choice as disabled Primary and available alternative as enabled Secondary", () => {
    const row = buildStateControlRow(booleanChoices, true);

    expect(row.type).toBe(ComponentType.ActionRow);
    expect(row.components).toHaveLength(2);

    const [requiredBtn, allowedBtn] = row.components;
    expect(requiredBtn.style).toBe(ButtonStyle.Secondary);
    expect(requiredBtn.disabled).toBe(false);
    expect(requiredBtn.label).toBe("Personal Providers Required");
    expect(requiredBtn.customId).toBe("mod:set:false");

    expect(allowedBtn.style).toBe(ButtonStyle.Primary);
    expect(allowedBtn.disabled).toBe(true);
    expect(allowedBtn.label).toBe("Server Models Allowed");
    expect(allowedBtn.customId).toBe("mod:set:true");
  });

  it("renders selected choice as disabled Primary when first option is selected", () => {
    const row = buildStateControlRow(booleanChoices, false);

    const [requiredBtn, allowedBtn] = row.components;
    expect(requiredBtn.style).toBe(ButtonStyle.Primary);
    expect(requiredBtn.disabled).toBe(true);

    expect(allowedBtn.style).toBe(ButtonStyle.Secondary);
    expect(allowedBtn.disabled).toBe(false);
  });

  it("renders unavailable alternative as disabled Secondary", () => {
    const stringChoices: readonly StateControlChoice<string>[] = [
      { value: "off", label: "Off", customId: "cfg:off" },
      { value: "on", label: "On", customId: "cfg:on", available: false },
    ];

    const row = buildStateControlRow(stringChoices, "off");

    const [offBtn, onBtn] = row.components;
    expect(offBtn.style).toBe(ButtonStyle.Primary);
    expect(offBtn.disabled).toBe(true);

    expect(onBtn.style).toBe(ButtonStyle.Secondary);
    expect(onBtn.disabled).toBe(true);
  });

  it("disables all buttons when writes are disabled while keeping selected choice Primary", () => {
    const threeChoices: readonly StateControlChoice<string>[] = [
      { value: "off", label: "Off", customId: "mode:off" },
      { value: "follow", label: "Follow Server", customId: "mode:follow" },
      { value: "on", label: "On", customId: "mode:on" },
    ];

    const row = buildStateControlRow(threeChoices, "follow", true);

    const [offBtn, followBtn, onBtn] = row.components;
    expect(offBtn.style).toBe(ButtonStyle.Secondary);
    expect(offBtn.disabled).toBe(true);

    expect(followBtn.style).toBe(ButtonStyle.Primary);
    expect(followBtn.disabled).toBe(true);

    expect(onBtn.style).toBe(ButtonStyle.Secondary);
    expect(onBtn.disabled).toBe(true);
  });
});
