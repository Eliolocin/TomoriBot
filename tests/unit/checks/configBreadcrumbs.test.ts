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
});
