import type { CustomEndpointApiStyle, CustomEndpointCapability } from "@/types/db/schema";
import type { PanelReadStatus } from "@/types/discord/panel";
import type { ImageEndpointSupports } from "@/utils/provider/customImageEndpointSupport";

export type ProviderPanelCapability = CustomEndpointCapability;

export interface ProviderPanelModel {
  id: number;
  codeName: string;
  isWorkspaceActive: boolean;
  isWorkspaceFallback: boolean;
  isProviderFallback: boolean;
  isCustomRegistration: boolean;
  textSettings?: {
    numCtx: number | null;
    hasTools: boolean;
    seesImages: boolean;
    supportsStructOutput: boolean;
    strictRoleAlternation: boolean;
    supportsPrefixCompletion: boolean;
  };
  imageSettings?: ImageEndpointSupports;
}

export interface ProviderPanelCapabilitySection {
  capability: ProviderPanelCapability;
  availability: "available" | "unavailable";
  models: ProviderPanelModel[];
  // Curated providers have no endpoint behind a capability, so this stays undefined for them. The
  // image modal reads it to decide whether inpainting is offerable at all.
  apiStyle?: CustomEndpointApiStyle;
}

interface ProviderPanelEntryBase {
  id: string;
  displayName: string;
  savedAt: Date | null;
}

interface CuratedProviderPanelEntry extends ProviderPanelEntryBase {
  kind: "provider";
  provider: string;
  rotationKeyCount: number;
  capabilities: ProviderPanelCapabilitySection[];
}

export interface EndpointProviderPanelEntry extends ProviderPanelEntryBase {
  kind: "endpoint";
  connectionIds: number[];
  isPreset: boolean;
  connectionDetails: Array<{
    connectionId: number;
    endpointUrl: string;
    apiStyle: CustomEndpointApiStyle;
  }>;
  capabilities: ProviderPanelCapabilitySection[];
}

interface BraveProviderPanelEntry extends ProviderPanelEntryBase {
  kind: "brave";
}

export type ProviderPanelEntry = CuratedProviderPanelEntry | EndpointProviderPanelEntry | BraveProviderPanelEntry;

export interface ProviderPanelScopeData {
  readStatus: PanelReadStatus;
  entries: ProviderPanelEntry[];
  initialEntryId: string | null;
}
