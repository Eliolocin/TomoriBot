import {
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ChatInputCommandInteraction,
  type ComponentInContainerData,
  type ContainerComponentData,
  type SelectMenuComponentOptionData,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import {
  buildStatusCategoryButtonId,
  buildStatusPersonaRangeSegments,
  buildStatusPersonaSelectorId,
  buildStatusPageSelectorId,
  STATUS_PERSONA_SELECT_PAGE_SIZE,
  type StatusCategory,
} from "@/utils/discord/statusDashboardCatalog";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { buildCategoryButtonRow, buildPaginationRow } from "@/utils/discord/ui/panel";
import { ColorCode } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export type { StatusCategory } from "@/utils/discord/statusDashboardCatalog";

export interface StatusPageCategory {
  id: StatusCategory;
  labelKey: string;
  pages: DashboardPage[];
}

export interface StatusPageRendererInput {
  locale: string;
  page: DashboardPage;
  buttonRows?: ActionRowData<ButtonComponentData>[];
  controlRows?: StatusControlRow[];
  thumbnailUrl?: string;
  disabled?: boolean;
}

export type StatusControlRow = ActionRowData<ButtonComponentData> | ActionRowData<StringSelectMenuComponentData>;

export interface StatusDashboardIdentity {
  /** The persona to preserve in subsequent category and page routes. */
  selectedPersonaId?: number | null;
  /** Fresh personas used only when the Persona category is visible. */
  personas?: readonly TomoriState[];
  /** Entry offset for the visible Persona selector range. */
  personaSelectStart?: number;
}

type DashboardPageField = SummaryEmbedOptions["fields"][number] | { separator: true };

/**
 * Common Components V2 page shape used by the status and stats dashboards.
 *
 * Both surfaces already produce localized field arrays. Sharing the layout primitive keeps their
 * flows from independently deciding where interactive rows belong.
 */
export interface DashboardPage extends Omit<SummaryEmbedOptions, "fields" | "thumbnailUrl"> {
  fields: DashboardPageField[];
  thumbnailUrl?: string;
}

function pageTitle(locale: string, page: DashboardPage): string {
  return localizer(locale, page.titleKey, page.titleVars);
}

function pageSubtitle(locale: string, page: DashboardPage): string {
  return page.description ?? (page.descriptionKey ? localizer(locale, page.descriptionKey, page.descriptionVars) : "");
}

function fieldText(locale: string, field: SummaryEmbedOptions["fields"][number]): string {
  const name = field.name ?? (field.nameKey ? localizer(locale, field.nameKey, field.nameVars) : "");
  const value = field.value ?? (field.valueKey ? localizer(locale, field.valueKey, field.valueVars) : "");
  return field.inline ? `**${name}:** ${value}` : `**${name}**\n${value}`;
}

/**
 * Renders status-style field arrays into a Components V2 container.
 * Action rows are placed before the body so category navigation remains visible above long status values.
 */
export function buildDashboardPagePayload(input: StatusPageRendererInput): {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
} {
  const { locale, page, buttonRows = [], controlRows = [], thumbnailUrl = page.thumbnailUrl } = input;
  const components: ComponentInContainerData[] = [];
  const appendTextDisplay = (content: string) => {
    components.push({ type: ComponentType.TextDisplay, content });
  };

  components.push(...buttonRows);
  if (buttonRows.length > 0) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
  }
  components.push(...controlRows);

  const subtitle = pageSubtitle(locale, page);
  if (thumbnailUrl) {
    const title = `### ${pageTitle(locale, page)}`;
    components.push({
      type: ComponentType.Section,
      components: [
        { type: ComponentType.TextDisplay, content: title },
        ...(subtitle ? [{ type: ComponentType.TextDisplay, content: `-# ${subtitle}` }] : []),
      ],
      accessory: { type: ComponentType.Thumbnail, media: { url: thumbnailUrl } },
    });
  } else {
    appendTextDisplay(`### ${pageTitle(locale, page)}${subtitle ? `\n-# ${subtitle}` : ""}`);
  }
  components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });

  let inlineFields: string[] = [];
  const flushInlineFields = () => {
    if (inlineFields.length === 0) return;
    appendTextDisplay(inlineFields.join("\n"));
    inlineFields = [];
  };

  for (const field of page.fields ?? []) {
    if ("separator" in field) {
      flushInlineFields();
      components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
      continue;
    }
    const content = fieldText(locale, field);
    if (field.inline) {
      inlineFields.push(content);
      continue;
    }
    flushInlineFields();
    appendTextDisplay(content);
  }
  flushInlineFields();

  if (page.footerKey) {
    components.push({ type: ComponentType.Separator, divider: true, spacing: 1 });
    appendTextDisplay(`-# ${localizer(locale, page.footerKey, page.footerVars)}`);
  }

  const accentColor =
    typeof page.color === "number"
      ? page.color
      : typeof page.color === "string"
        ? Number.parseInt(page.color.replace("#", ""), 16)
        : Number.parseInt(ColorCode.INFO.replace("#", ""), 16);

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor,
    components,
  };

  return validateAndFallbackPanelPayload(
    {
      components: [container],
      flags: MessageFlags.IsComponentsV2,
    },
    locale,
  );
}

/**
 * Renders persistent category controls. Persona is a normal global route; an optional selected
 * persona ID is carried on every button while the dashboard is displaying a persona.
 */
function categoryButtonRows(
  _interactionId: string,
  locale: string,
  categories: StatusPageCategory[],
  activeCategory: StatusCategory,
  disabled: boolean,
  selectedPersonaId: number | null | undefined,
): ActionRowData<ButtonComponentData>[] {
  const row = buildCategoryButtonRow(
    categories.map((category) => ({
      id: category.id,
      label: localizer(locale, category.labelKey),
      customId: buildStatusCategoryButtonId(locale, category.id, selectedPersonaId),
    })),
    activeCategory,
    disabled,
  );

  return [
    {
      ...row,
      components: row.components.map((button) => ({ ...button, disabled })),
    },
  ];
}

function safeSelectText(value: string | null | undefined, maxLength: number, fallback: string): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function personaWithId(persona: TomoriState): persona is TomoriState & { persona_id: number } {
  return typeof persona.persona_id === "number" && Number.isSafeInteger(persona.persona_id) && persona.persona_id > 0;
}

function personaSelectStart(
  personas: readonly (TomoriState & { persona_id: number })[],
  selectedPersonaId: number,
): number {
  const selectedIndex = personas.findIndex((persona) => persona.persona_id === selectedPersonaId);
  return selectedIndex < 0
    ? 0
    : Math.floor(selectedIndex / STATUS_PERSONA_SELECT_PAGE_SIZE) * STATUS_PERSONA_SELECT_PAGE_SIZE;
}

function personaSelectorRows(
  locale: string,
  personas: readonly TomoriState[],
  selectedPersonaId: number | null | undefined,
  requestedStart: number | undefined,
  disabled: boolean,
): ActionRowData<StringSelectMenuComponentData>[] {
  const selectablePersonas = personas.filter(personaWithId);
  if (selectablePersonas.length === 0) return [];

  const selectedPersona = selectablePersonas.find((persona) => persona.persona_id === selectedPersonaId);
  const effectiveSelectedId = selectedPersona?.persona_id ?? selectablePersonas[0]?.persona_id;
  if (effectiveSelectedId === undefined) return [];

  const pageCount = Math.max(1, Math.ceil(selectablePersonas.length / STATUS_PERSONA_SELECT_PAGE_SIZE));
  const defaultStart = personaSelectStart(selectablePersonas, effectiveSelectedId);
  const requestedPage = Math.floor((requestedStart ?? defaultStart) / STATUS_PERSONA_SELECT_PAGE_SIZE);
  const rangeIndex = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 0, 0), pageCount - 1);
  const start = rangeIndex * STATUS_PERSONA_SELECT_PAGE_SIZE;
  const visiblePersonas = selectablePersonas.slice(start, start + STATUS_PERSONA_SELECT_PAGE_SIZE);
  const personaFallback = localizer(locale, "commands.status.scope_choice_persona");
  const placeholder = selectedPersona
    ? safeSelectText(selectedPersona.persona_nickname, 150, personaFallback)
    : safeSelectText(localizer(locale, "commands.config.panel.persona_select_placeholder"), 150, personaFallback);
  const options: SelectMenuComponentOptionData[] = visiblePersonas.map((persona) => ({
    label: safeSelectText(persona.persona_nickname, 100, personaFallback),
    value: String(persona.persona_id),
    default: persona.persona_id === effectiveSelectedId,
  }));

  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: buildStatusPersonaSelectorId(locale, effectiveSelectedId),
          placeholder,
          disabled,
          options,
        },
      ],
    },
  ];
}

function personaRangeRow(
  locale: string,
  personas: readonly TomoriState[],
  selectedPersonaId: number | null | undefined,
  requestedStart: number | undefined,
  disabled: boolean,
): ActionRowData<ButtonComponentData>[] {
  const selectablePersonas = personas.filter(personaWithId);
  if (selectablePersonas.length <= STATUS_PERSONA_SELECT_PAGE_SIZE) return [];

  const selectedPersona = selectablePersonas.find((persona) => persona.persona_id === selectedPersonaId);
  const effectiveSelectedId = selectedPersona?.persona_id ?? selectablePersonas[0]?.persona_id;
  if (effectiveSelectedId === undefined) return [];

  const pageCount = Math.max(1, Math.ceil(selectablePersonas.length / STATUS_PERSONA_SELECT_PAGE_SIZE));
  const defaultStart = personaSelectStart(selectablePersonas, effectiveSelectedId);
  const requestedPage = Math.floor((requestedStart ?? defaultStart) / STATUS_PERSONA_SELECT_PAGE_SIZE);
  const rangeIndex = Math.min(Math.max(Number.isFinite(requestedPage) ? requestedPage : 0, 0), pageCount - 1);
  const row = buildPaginationRow({
    locale,
    rangeIndex,
    rangeCount: pageCount,
    disabled,
    namespace: "status",
    version: "v1",
    buildSegments: {
      page: (targetRangeIndex) =>
        buildStatusPersonaRangeSegments(
          locale,
          effectiveSelectedId,
          targetRangeIndex * STATUS_PERSONA_SELECT_PAGE_SIZE,
        ),
    },
  });
  return row ? [row] : [];
}

function pageControlRows(
  _interactionId: string,
  locale: string,
  category: StatusPageCategory,
  activePage: number,
  disabled: boolean,
  identity: StatusDashboardIdentity,
): StatusControlRow[] {
  const controls: StatusControlRow[] = [];
  if (category.id === "persona" && identity.personas) {
    controls.push(
      ...personaSelectorRows(
        locale,
        identity.personas,
        identity.selectedPersonaId,
        identity.personaSelectStart,
        disabled,
      ),
    );
  }
  if (category.pages.length <= 1) return controls;
  controls.push({
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildStatusPageSelectorId(locale, category.id, identity.selectedPersonaId),
        placeholder: localizer(locale, "commands.config.panel.page_select_placeholder"),
        disabled,
        options: category.pages.map((page, index) => ({
          label: selectorPageLabel(locale, page),
          value: String(index),
          default: index === activePage,
        })),
      },
    ],
  });
  return controls;
}

function selectorPageLabel(locale: string, page: DashboardPage): string {
  const title = pageTitle(locale, page);
  const colonIndex = title.indexOf(":");
  return (colonIndex >= 0 ? title.slice(colonIndex + 1).trim() : title).slice(0, 100);
}

export function dashboardPayload(
  interactionId: string,
  locale: string,
  categories: StatusPageCategory[],
  activeCategory: StatusCategory,
  activePage: number,
  disabled: boolean,
  identity: StatusDashboardIdentity = {},
) {
  const category = categories.find((candidate) => candidate.id === activeCategory) ?? categories[0];
  const page = category.pages[Math.min(activePage, category.pages.length - 1)];
  return buildDashboardPagePayload({
    locale,
    page,
    buttonRows: categoryButtonRows(
      interactionId,
      locale,
      categories,
      category.id,
      disabled,
      identity.selectedPersonaId,
    ),
    controlRows: [
      ...pageControlRows(interactionId, locale, category, activePage, disabled, identity),
      ...(category.id === "persona" && identity.personas
        ? personaRangeRow(locale, identity.personas, identity.selectedPersonaId, identity.personaSelectStart, disabled)
        : []),
    ],
    disabled,
  });
}

/**
 * Displays a private status dashboard. Persistent controls are handled by the global route registry.
 */
export async function renderStatusPageDashboard(
  interaction: ChatInputCommandInteraction,
  locale: string,
  categories: StatusPageCategory[],
  initialCategory: StatusCategory,
  identity: StatusDashboardIdentity = {},
): Promise<void> {
  const initial = categories.find((category) => category.id === initialCategory);
  if (!initial || initial.pages.length === 0) return;

  const activeCategory = initial.id;
  const activePage = 0;
  const render = (disabled = false) =>
    dashboardPayload(interaction.id, locale, categories, activeCategory, activePage, disabled, identity);

  await interaction.editReply(render());
}
