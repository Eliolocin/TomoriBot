import { describe, expect, it } from "bun:test";
import {
  auditPersonaWorkflowBoundary,
  INTERNAL_PERSONA_WORKFLOW_PATHS,
  scanPersonaWorkflowSource,
  type PersonaWorkflowViolationKind,
} from "../../../scripts/checks/lib/personaWorkflowBoundary";

function kinds(source: string, file = "src/commands/example.ts"): PersonaWorkflowViolationKind[] {
  return scanPersonaWorkflowSource(source, file).map((violation) => violation.kind);
}

describe("persona workflow boundary scanner, synthetic cases", () => {
  it("detects a direct low-level picker import and call", () => {
    const source = `
      import { replyPaginatedPersonaChoicesV2 } from "@/utils/discord/ui/personaPagination";
      await replyPaginatedPersonaChoicesV2(interaction, locale, { personas });
    `;

    expect(kinds(source)).toContain("low-level-picker-import");
    expect(kinds(source)).toContain("low-level-picker-call");
  });

  it("detects aliased and namespace-qualified low-level picker calls", () => {
    const aliased = `
      import { replyPaginatedPersonaChoicesV2 as pickPersona } from "@/utils/discord/ui/personaPagination";
      await pickPersona(interaction, locale, { personas });
    `;
    const namespace = `
      import * as pickerUi from "@/utils/discord/ui/personaPagination";
      await pickerUi.replyPaginatedPersonaChoicesV2(interaction, locale, { personas });
    `;

    expect(kinds(aliased)).toContain("low-level-picker-call");
    expect(kinds(namespace)).toContain("low-level-picker-call");
  });

  it("detects manual selected-interaction preservation but ignores false", () => {
    expect(kinds("const options = { preserveSelectedInteraction: true };")).toContain("preserved-selected-interaction");
    expect(kinds("const options = { preserveSelectedInteraction: false };")).not.toContain(
      "preserved-selected-interaction",
    );
  });

  it("detects empty picker callbacks across formatting and comments", () => {
    const source = `
      const options = {
        personas,
        onSelect: async () => {
          // Deliberately empty legacy callback.
        },
      };
    `;
    expect(kinds(source)).toContain("empty-picker-on-select");
    expect(kinds("const options = { personas, async onSelect() {} };")).toContain("empty-picker-on-select");
  });

  it("ignores useful callbacks and unrelated empty onSelect handlers", () => {
    const usefulPicker = "const options = { personas, onSelect: async (index) => { await save(index); } };";
    const unrelated = "const observer = { onSelect: () => {} };";

    expect(kinds(usefulPicker)).not.toContain("empty-picker-on-select");
    expect(kinds(unrelated)).not.toContain("empty-picker-on-select");
  });

  it("detects a selection callback that acknowledges the interaction itself", () => {
    const deferred = `
      const options = {
        personas,
        async onSelected(selection) {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          return completePersonaWorkflow();
        },
      };
    `;
    const replied = `
      await runPersonaPickerWorkflow(interaction, locale, {
        personas,
        onSelected: async (selection) => {
          await selection.unsafeInteractions().root.reply({ content: "done" });
          return completePersonaWorkflow();
        },
      });
    `;

    expect(kinds(deferred)).toContain("self-acknowledging-on-selected");
    expect(kinds(replied)).toContain("self-acknowledging-on-selected");
  });

  it("permits in-place work, public replies, and acknowledgement outside the selection callback", () => {
    // The workflow's own acknowledgement lives in the message controller, a command may legitimately
    // defer before it ever calls the workflow, and posting the separate public message is the
    // workflow's documented phase rather than an acknowledgement. None of those may be flagged.
    const inPlaceWork = `
      await runPersonaPickerWorkflow(interaction, locale, {
        personas,
        onSelected: async (selection) => {
          const work = await selection.beginInPlaceWork();
          await work.message.replace(payload);
          return completePersonaWorkflow();
        },
      });
    `;
    const separatePublicReply = `
      await runPersonaPickerWorkflow(interaction, locale, {
        personas,
        onSelected: async (selection) => {
          const publicReply: PersonaWorkflowPublicReplyPhase = await selection.beginSeparatePublicReply(compact);
          await publicReply.reply({ files: [attachment] });
          return completePersonaWorkflow();
        },
      });
    `;
    const deferredBeforeTheCall = `
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await runPersonaPickerWorkflow(interaction, locale, {
        personas,
        onSelected: async () => completePersonaWorkflow(),
      });
    `;

    expect(kinds(inPlaceWork)).not.toContain("self-acknowledging-on-selected");
    expect(kinds(separatePublicReply)).not.toContain("self-acknowledging-on-selected");
    expect(kinds(deferredBeforeTheCall)).not.toContain("self-acknowledging-on-selected");
  });

  it("detects the competing conditioning helper declaration, import, and call", () => {
    const declaration = "export async function selectConditioningPersona() { return null; }";
    const importedCall = `
      import { selectConditioningPersona as selectPersona } from "@/utils/conditioning/conditioningCommandHelper";
      await selectPersona(interaction, locale);
    `;

    expect(kinds(declaration)).toContain("competing-persona-helper");
    expect(kinds(importedCall).filter((kind) => kind === "competing-persona-helper").length).toBeGreaterThanOrEqual(2);
  });

  it("ignores restricted names inside comments and strings", () => {
    const source = `
      // replyPaginatedPersonaChoicesV2(interaction, locale, options)
      const documentation = "preserveSelectedInteraction: true; selectConditioningPersona()";
    `;
    expect(scanPersonaWorkflowSource(source, "src/commands/example.ts")).toEqual([]);
  });

  it("allows only the explicit workflow and primitive files", () => {
    const source = `
      import { replyPaginatedPersonaChoicesV2 } from "./personaPagination";
      replyPaginatedPersonaChoicesV2(interaction, locale, {
        personas,
        preserveSelectedInteraction: true,
        onSelect: async () => {},
      });
    `;

    const internalPaths = [...INTERNAL_PERSONA_WORKFLOW_PATHS.keys()];
    expect(internalPaths).toEqual([
      "src/utils/discord/ui/interactionCore.ts",
      "src/utils/discord/ui/personaWorkflow.ts",
    ]);
    for (const internalPath of internalPaths) {
      expect(scanPersonaWorkflowSource(source, internalPath)).toEqual([]);
    }
    expect(scanPersonaWorkflowSource(source, "src/utils/discord/ui/notActuallyInternal.ts").length).toBeGreaterThan(0);
  });
});

describe("persona workflow boundary, real source tree", () => {
  it("scans the real tree rather than passing on an empty workload", async () => {
    // Without this floor the audit passes vacuously: a moved solver directory, a changed audit root,
    // or a relocated repo root empties `candidates`, so `violations` is trivially [] and the boundary
    // reads as guarded while nothing was scanned. Deliberately well under the real count so ordinary
    // churn is free and only a structural break trips it.
    const { scannedFiles } = await auditPersonaWorkflowBoundary();

    expect(scannedFiles).toBeGreaterThan(300);
  });

  it("has no command or feature code bypassing the anchor workflow", async () => {
    const { violations } = await auditPersonaWorkflowBoundary();
    const detail = violations
      .map((violation) => `${violation.file}:${violation.line}:${violation.column} [${violation.kind}]`)
      .join("\n");

    expect(
      violations,
      `Persona workflow boundary violations:\n${detail}\n\n` +
        "Fix: migrate callers to src/utils/discord/ui/personaWorkflow.ts. Low-level picker access and " +
        "legacy preservation/callback boilerplate are internal-only.\n" +
        "Every violation is listed above; the scanner lives in scripts/checks/lib/personaWorkflowBoundary.ts.",
    ).toHaveLength(0);
  });
});
