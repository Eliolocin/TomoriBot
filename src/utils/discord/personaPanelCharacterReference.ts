import { AttachmentBuilder } from "discord.js";
import { resolveCharRefDisplayAsset, type CharRefDisplayAsset } from "@/utils/storage/charrefStorage";

export interface PersonaPanelCharacterReferenceData {
  url: string | null;
  files: AttachmentBuilder[];
}

export interface PersonaPanelCharacterReferenceDependencies {
  resolveDisplayAsset(reference: string | null | undefined, personaId: number): Promise<CharRefDisplayAsset | null>;
}

const defaultDependencies: PersonaPanelCharacterReferenceDependencies = {
  resolveDisplayAsset: resolveCharRefDisplayAsset,
};

export async function resolvePersonaPanelCharacterReference(
  reference: string | null | undefined,
  personaId: number,
  attachmentName: string,
  dependencies: PersonaPanelCharacterReferenceDependencies = defaultDependencies,
): Promise<PersonaPanelCharacterReferenceData> {
  const asset = await dependencies.resolveDisplayAsset(reference, personaId);
  if (!asset) {
    return { url: null, files: [] };
  }

  if (asset.type === "url") {
    return { url: asset.url, files: [] };
  }

  return {
    url: `attachment://${attachmentName}`,
    files: [new AttachmentBuilder(asset.buffer, { name: attachmentName })],
  };
}
