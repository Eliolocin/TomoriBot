import type { CustomEndpointRow } from "@/types/db/schema";

const CUSTOM_PROVIDER_PREFIX = "custom:";
const CUSTOM_LABEL_PATTERN = /^[a-z0-9_-]{1,40}$/;
const customProviderLabels = new Map<number, string>();

export interface ParsedCustomProvider {
  raw: string;
  connectionId: number;
}

export function isCustomProvider(provider: string): boolean {
  return provider.trim().toLowerCase().startsWith(CUSTOM_PROVIDER_PREFIX);
}

export function normalizeCustomEndpointLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function isValidCustomEndpointLabel(label: string): boolean {
  return CUSTOM_LABEL_PATTERN.test(normalizeCustomEndpointLabel(label));
}

export function buildCustomProviderName(connectionId: number): string {
  return `${CUSTOM_PROVIDER_PREFIX}${connectionId}`;
}

export function parseCustomProvider(provider: string): ParsedCustomProvider | null {
  const normalized = provider.trim().toLowerCase();
  if (!isCustomProvider(normalized)) {
    return null;
  }

  const payload = normalized.slice(CUSTOM_PROVIDER_PREFIX.length).trim();
  const connectionId = Number.parseInt(payload, 10);
  if (!Number.isInteger(connectionId) || connectionId <= 0 || String(connectionId) !== payload) {
    return null;
  }

  return {
    raw: normalized,
    connectionId,
  };
}

export function rememberCustomProviderLabel(provider: string, label: string | null | undefined): void {
  const parsed = parseCustomProvider(provider);
  const normalizedLabel = label?.trim();
  if (parsed && normalizedLabel) {
    customProviderLabels.set(parsed.connectionId, normalizedLabel);
  }
}

export function getCustomProviderDisplayName(provider: string, label?: string | null): string {
  const parsed = parseCustomProvider(provider);
  const resolvedLabel = label?.trim() || (parsed ? customProviderLabels.get(parsed.connectionId) : null);
  if (resolvedLabel) {
    return `Custom Endpoint: ${resolvedLabel}`;
  }
  return "Custom Endpoint";
}

export function buildSyntheticCustomModelCodename(label: string, modelName?: string | null): string {
  const trimmed = modelName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : normalizeCustomEndpointLabel(label);
}

export function formatCustomModelDisplay(endpoint: Pick<CustomEndpointRow, "label" | "model_name">): string {
  const label = normalizeCustomEndpointLabel(endpoint.label);
  const modelName = endpoint.model_name?.trim() || label;
  return `${modelName} (${label})`;
}
