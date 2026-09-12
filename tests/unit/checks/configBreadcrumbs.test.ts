import { beforeAll, describe, expect, it } from "bun:test";
import { inspectSourceForBreadcrumbs } from "../../../scripts/checks/checkConfigBreadcrumbs";
import { initializeLocalizer } from "../../../src/utils/text/localizer";

describe("checkConfigBreadcrumbs", () => {
  beforeAll(async () => {
    await initializeLocalizer();
  });

  it("passes valid post-conversion breadcrumb calls", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.persona.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(0);
  });

  it("detects single-argument English literal calls", () => {
    const source = ["const vars = () => ({", '  trigger: configPage("Persona > General"),', "});"].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("invalid-signature");
  });

  it("detects two-argument English literal calls", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "Persona > General"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("english-literal");
  });

  it("detects nonexistent categories in breadcrumb keys", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.nonexistent.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("nonexistent-category");
  });

  it("detects nonexistent pages in breadcrumb keys", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.persona.nonexistent"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("nonexistent-page");
  });

  it("detects missing locale keys in en-US", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.persona.triggers"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, (key) => key);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("missing-key");
  });

  it("detects a locale value that drifted from the config panel labels", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.persona.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, () => "Persona > General");
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("stale-label-mapping");
  });

  it("passes valid personal config breadcrumb calls", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  profile: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.general"),',
      '  privacy: personalConfigPage(locale, "commands.help.breadcrumbs.personal.privacy.controls"),',
      '  models: personalConfigPage(locale, "commands.help.breadcrumbs.personal.models.switch"),',
      '  advanced: personalConfigPage(locale, "commands.help.breadcrumbs.personal.advanced.spotlight"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(4);
    expect(result.findings).toHaveLength(0);
  });

  it("passes valid moderation breadcrumb calls", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  memberAccess: moderationPage(locale, "commands.help.breadcrumbs.moderation.member-access"),',
      '  userBlacklist: moderationPage(locale, "commands.help.breadcrumbs.moderation.user-blacklist"),',
      '  whitelist: moderationPage(locale, "commands.help.breadcrumbs.moderation.whitelist"),',
      '  quotas: moderationPage(locale, "commands.help.breadcrumbs.moderation.quotas"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(4);
    expect(result.findings).toHaveLength(0);
  });

  it("passes valid shared breadcrumbPage calls across all roots", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  config: breadcrumbPage("config", locale, "commands.help.breadcrumbs.persona.voice"),',
      '  personal: breadcrumbPage("personal", locale, "commands.help.breadcrumbs.personal.profile.general"),',
      '  moderation: breadcrumbPage("moderation", locale, "commands.help.breadcrumbs.moderation.quotas"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(3);
    expect(result.findings).toHaveLength(0);
  });

  it("passes valid calls for the six newly added config breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  voice: configPage(locale, "commands.help.breadcrumbs.persona.voice"),',
      '  sprites: configPage(locale, "commands.help.breadcrumbs.persona.sprites"),',
      '  voices: configPage(locale, "commands.help.breadcrumbs.models.voices"),',
      '  image: configPage(locale, "commands.help.breadcrumbs.models.image"),',
      '  parameters: configPage(locale, "commands.help.breadcrumbs.models.parameters"),',
      '  overrides: configPage(locale, "commands.help.breadcrumbs.channels.overrides"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(6);
    expect(result.findings).toHaveLength(0);
  });

  it("detects wrong root and namespace mismatch for personal helper", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: personalConfigPage(locale, "commands.help.breadcrumbs.persona.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("wrong-root-namespace");
  });

  it("detects wrong root and namespace mismatch for config helper", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: configPage(locale, "commands.help.breadcrumbs.personal.profile.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("wrong-root-namespace");
  });

  it("detects wrong root and namespace mismatch for moderation helper", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: moderationPage(locale, "commands.help.breadcrumbs.personal.profile.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("wrong-root-namespace");
  });

  it("detects nonexistent category in personal breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: personalConfigPage(locale, "commands.help.breadcrumbs.personal.nonexistent.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("nonexistent-category");
  });

  it("detects nonexistent page in personal breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.nonexistent"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("nonexistent-page");
  });

  it("detects nonexistent category in moderation breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: moderationPage(locale, "commands.help.breadcrumbs.moderation.nonexistent"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("nonexistent-category");
  });

  it("detects missing locale key in personal breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.appearance"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, (key) => key);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("missing-key");
  });

  it("detects missing locale key in moderation breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: moderationPage(locale, "commands.help.breadcrumbs.moderation.quotas"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, (key) => key);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("missing-key");
  });

  it("detects label drift in personal breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: personalConfigPage(locale, "commands.help.breadcrumbs.personal.profile.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, () => "Profile > General");
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("stale-label-mapping");
  });

  it("detects label drift in moderation breadcrumbs", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: moderationPage(locale, "commands.help.breadcrumbs.moderation.member-access"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source, undefined, () => "Member Access Controls");
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("stale-label-mapping");
  });

  it("detects invalid root in shared breadcrumbPage helper", () => {
    const source = [
      "const vars = (locale: string) => ({",
      '  trigger: breadcrumbPage("unknown", locale, "commands.help.breadcrumbs.persona.general"),',
      "});",
    ].join("\n");

    const result = inspectSourceForBreadcrumbs(source);
    expect(result.callCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.kind).toBe("invalid-signature");
  });
});
