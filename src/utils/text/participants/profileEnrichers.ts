import {
  aggregateContributionDiagnostics,
  createContributionRegistry,
  executeContribution,
  type ContributionExecutionDiagnostic,
  type ContributionMeta,
  type ContributionRegistry,
} from "@/utils/contributions/registry";
import type {
  ActivePersonaScope,
  HydratedParticipantProfile,
  ParticipantFieldVisibilityReason,
  ParticipantProfileField,
  ParticipantProfileFieldKind,
} from "@/utils/text/participants/hydration";

const DEFAULT_ENRICHER_TIMEOUT_MS = 1_500;

type HydratedParticipantBase = Omit<HydratedParticipantProfile, "fields">;

interface ParticipantProfileFieldContribution {
  kind: ParticipantProfileFieldKind | `extension:${string}`;
  visibility: {
    visible: boolean;
    reason: ParticipantFieldVisibilityReason;
  };
  lines: readonly string[];
  order?: number;
}

interface ParticipantHydrationContext {
  activePersonaScope: Readonly<ActivePersonaScope>;
  coreFields: readonly ParticipantProfileFieldContribution[];
}

export interface ParticipantProfileEnricher {
  meta: ContributionMeta;
  supports(participant: Readonly<HydratedParticipantBase>): boolean;
  enrich(
    participant: Readonly<HydratedParticipantBase>,
    context: Readonly<ParticipantHydrationContext>,
    signal: AbortSignal,
  ): Promise<readonly ParticipantProfileFieldContribution[]>;
}

export interface ParticipantProfileEnricherRegistration {
  enricher: ParticipantProfileEnricher;
}

interface RegisteredParticipantProfileEnricher {
  meta: ContributionMeta;
  enricher: ParticipantProfileEnricher;
  preserveFieldOrder: boolean;
}

export type ParticipantProfileEnricherRegistry = ContributionRegistry<RegisteredParticipantProfileEnricher>;

export interface ParticipantProfileEnrichmentResult {
  profiles: readonly HydratedParticipantProfile[];
  diagnostics: readonly ContributionExecutionDiagnostic[];
}

function enricherTimeoutMs(): number {
  const configured = Number.parseInt(process.env.PARTICIPANT_ENRICHER_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ENRICHER_TIMEOUT_MS;
}

function coreFieldEnricher(
  id: string,
  kind: ParticipantProfileFieldKind,
  order: number,
  after?: string,
): ParticipantProfileEnricher {
  return {
    meta: {
      id,
      owner: "participant-core",
      source: "src/utils/text/participants/hydration.ts",
      order,
      criticality: "critical",
      ...(after && { after: [after] }),
    },
    supports: () => true,
    enrich: async (_participant, context) => context.coreFields.filter((field) => field.kind === kind),
  };
}

const CORE_FIELD_ENRICHERS: readonly ParticipantProfileEnricher[] = [
  coreFieldEnricher("core.status", "status", 100),
  coreFieldEnricher("core.physical-appearance", "physical_appearance", 110, "core.status"),
  coreFieldEnricher("core.naming", "naming", 112, "core.physical-appearance"),
  coreFieldEnricher("core.identity", "identity", 115, "core.naming"),
  coreFieldEnricher("core.timezone", "timezone", 120, "core.identity"),
  coreFieldEnricher("core.presence", "presence", 130, "core.timezone"),
  coreFieldEnricher("core.roles", "roles", 140, "core.presence"),
  coreFieldEnricher("core.personal-memories", "personal_memories", 150, "core.roles"),
  coreFieldEnricher("core.human-reminders", "human_reminders", 160, "core.personal-memories"),
  coreFieldEnricher("core.persona-public-attributes", "persona_public_attributes", 170, "core.human-reminders"),
  {
    meta: {
      id: "core.profile-fields",
      owner: "participant-core",
      source: "src/utils/text/participants/profileEnrichers.ts",
      order: 180,
      criticality: "critical",
      after: ["core.persona-public-attributes"],
    },
    supports: () => true,
    enrich: async () => [],
  },
];

export function createParticipantProfileEnricherRegistry(
  additions: readonly ParticipantProfileEnricherRegistration[] = [],
): ParticipantProfileEnricherRegistry {
  return createContributionRegistry("participant profile enricher", [
    ...CORE_FIELD_ENRICHERS.map((enricher) => ({ meta: enricher.meta, enricher, preserveFieldOrder: true })),
    ...additions.map(({ enricher }) => ({
      meta: enricher.meta,
      enricher,
      preserveFieldOrder: false,
    })),
  ]);
}

const CORE_PARTICIPANT_PROFILE_ENRICHER_REGISTRY = createParticipantProfileEnricherRegistry();

function readonlyParticipantBase(profile: HydratedParticipantProfile): Readonly<HydratedParticipantBase> {
  return Object.freeze({
    key: Object.freeze({ ...profile.key }),
    reasons: new Set(profile.reasons),
    displayName: profile.displayName,
    aliases: Object.freeze(
      profile.aliases.map((alias) =>
        Object.freeze({
          ...alias,
          owner: Object.freeze({ ...alias.owner }),
          purposes: new Set(alias.purposes),
        }),
      ),
    ),
    primaryAlias: profile.primaryAlias,
    mentionable: profile.mentionable,
    isBot: profile.isBot,
    ...(profile.resolvableTargetId && { resolvableTargetId: profile.resolvableTargetId }),
  });
}

function coreFieldContribution(field: ParticipantProfileField): ParticipantProfileFieldContribution {
  return Object.freeze({
    kind: field.kind,
    visibility: Object.freeze({ ...field.visibility }),
    lines: Object.freeze([...field.lines]),
    order: field.order,
  });
}

export async function applyParticipantProfileEnrichers(params: {
  profiles: readonly HydratedParticipantProfile[];
  activePersonaScope: ActivePersonaScope;
  registry?: ParticipantProfileEnricherRegistry;
}): Promise<ParticipantProfileEnrichmentResult> {
  const registry = params.registry ?? CORE_PARTICIPANT_PROFILE_ENRICHER_REGISTRY;
  const profiles: HydratedParticipantProfile[] = [];
  const diagnostics: ContributionExecutionDiagnostic[] = [];

  for (const profile of params.profiles) {
    const participant = readonlyParticipantBase(profile);
    const coreFields = Object.freeze(profile.fields.map(coreFieldContribution));
    const context: ParticipantHydrationContext = Object.freeze({
      activePersonaScope: Object.freeze({ ...params.activePersonaScope }),
      coreFields,
    });
    const fields: ParticipantProfileField[] = [];
    let nextExtensionOrder = Math.max(0, ...profile.fields.map((field) => field.order)) + 1;

    for (const registration of registry.ordered) {
      const executed = await executeContribution<readonly ParticipantProfileFieldContribution[]>({
        descriptor: registration,
        timeoutMs: enricherTimeoutMs(),
        outputCount: (output) => output.length,
        run: async (signal) => {
          if (!registration.enricher.supports(participant)) return [];
          const output = await registration.enricher.enrich(participant, context, signal);
          if (
            !registration.preserveFieldOrder &&
            output.some((field) => !field.kind.startsWith(`extension:${registration.meta.id}`))
          ) {
            throw new Error(`Enricher fields must use the extension:${registration.meta.id} namespace`);
          }
          return output;
        },
      });
      diagnostics.push(executed.diagnostic);
      for (const contribution of executed.value ?? []) {
        fields.push({
          owner: profile.key,
          kind: contribution.kind,
          order:
            registration.preserveFieldOrder && contribution.order !== undefined
              ? contribution.order
              : nextExtensionOrder++,
          visibility: { ...contribution.visibility },
          lines: [...contribution.lines],
        });
      }
    }
    profiles.push({ ...profile, fields });
  }

  return { profiles, diagnostics: aggregateContributionDiagnostics(diagnostics) };
}
