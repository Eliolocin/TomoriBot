import {
  ComponentType,
  MessageFlags,
  type ActionRowData,
  type ButtonComponentData,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ComponentInContainerData,
  type ContainerComponentData,
  type Message,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import type { SummaryEmbedOptions } from "@/types/discord/embed";
import { validateAndFallbackPanelPayload } from "@/utils/discord/ui/interactionCore";
import { buildCategoryButtonRow } from "@/utils/discord/ui/panel";
import { PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS } from "@/utils/discord/ui/personaWorkflow";
import { ColorCode, log } from "@/utils/misc/logger";
import { localizer } from "@/utils/text/localizer";

export type StatusCategory = "persona" | "behavior" | "models" | "access" | "personal";

export interface StatusPageCategory {
  id: StatusCategory;
  labelKey: string;
  pages: DashboardPage[];
}

export interface StatusPageRendererInput {
  locale: string;
  page: DashboardPage;
  buttonRows?: ActionRowData<ButtonComponentData>[];
  controlRows?: ActionRowData<StringSelectMenuComponentData>[];
  thumbnailUrl?: string;
  disabled?: boolean;
}

type DashboardPageField = SummaryEmbedOptions["fields"][number] | { separator: true };

/**
 * Common Components V2 page shape used by the status and stats dashboards.
 *
 * Both surfaces already produce localized field arrays. Sharing the layout primitive keeps their
 * collectors from independently deciding where interactive rows belong.
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

/** Backward-compatible status name while callers migrate to the shared renderer. */
function categoryButtonRows(
  interactionId: string,
  locale: string,
  categories: StatusPageCategory[],
  activeCategory: StatusCategory,
  disabled: boolean,
): ActionRowData<ButtonComponentData>[] {
  return [
    buildCategoryButtonRow(
      categories.map((category) => ({
        id: category.id,
        label: localizer(locale, category.labelKey),
        customId: `status:${interactionId}:category:${category.id}`,
      })),
      activeCategory,
      disabled,
    ),
  ];
}

function pageControlRows(
  interactionId: string,
  locale: string,
  category: StatusPageCategory,
  activePage: number,
  disabled: boolean,
): ActionRowData<StringSelectMenuComponentData>[] {
  if (category.pages.length <= 1) return [];
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          customId: `status:${interactionId}:page:${category.id}`,
          placeholder: localizer(locale, "commands.config.panel.page_select_placeholder"),
          disabled,
          options: category.pages.map((page, index) => ({
            label: pageTitle(locale, page).slice(0, 100),
            value: String(index),
            default: index === activePage,
          })),
        },
      ],
    },
  ];
}

export function dashboardPayload(
  interactionId: string,
  locale: string,
  categories: StatusPageCategory[],
  activeCategory: StatusCategory,
  activePage: number,
  disabled: boolean,
) {
  const category = categories.find((candidate) => candidate.id === activeCategory) ?? categories[0];
  const page = category.pages[Math.min(activePage, category.pages.length - 1)];
  return buildDashboardPagePayload({
    locale,
    page,
    buttonRows: categoryButtonRows(interactionId, locale, categories, category.id, disabled),
    controlRows: pageControlRows(interactionId, locale, category, activePage, disabled),
    disabled,
  });
}

export type PersonaCategorySelectHandler = (interaction: ButtonInteraction) => Promise<void>;

/**
 * Displays a private, selector-driven status dashboard.
 * The caller supplies already-built pages, so collector updates cannot repeat database reads.
 */
export async function renderStatusPageDashboard(
  interaction: ChatInputCommandInteraction,
  locale: string,
  categories: StatusPageCategory[],
  initialCategory: StatusCategory,
  onSelectPersona?: PersonaCategorySelectHandler,
): Promise<void> {
  const initial = categories.find((category) => category.id === initialCategory);
  if (!initial || initial.pages.length === 0) return;

  let activeCategory = initial.id;
  let activePage = 0;
  const render = (disabled = false) =>
    dashboardPayload(interaction.id, locale, categories, activeCategory, activePage, disabled);

  const message = (await interaction.editReply(render())) as Message;
  const collector = message.createMessageComponentCollector({
    time: PERSONA_WORKFLOW_COMPONENT_TIMEOUT_MS,
    filter: (candidate) =>
      candidate.user.id === interaction.user.id && candidate.customId.startsWith(`status:${interaction.id}:`),
  });

  collector.on("collect", async (component) => {
    const [, , action, value] = component.customId.split(":");
    if (action === "category") {
      if (value === "persona" && onSelectPersona) {
        collector.stop("persona_transition");
        await onSelectPersona(component as ButtonInteraction);
        return;
      }
      const category = categories.find((candidate) => candidate.id === value);
      if (!category || category.pages.length === 0) return;
      activeCategory = category.id;
      activePage = 0;
    } else if (action === "page") {
      const pageIndex = component.isStringSelectMenu() ? Number.parseInt(component.values[0] ?? "", 10) : Number.NaN;
      const category = categories.find((candidate) => candidate.id === activeCategory);
      if (!category || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= category.pages.length) return;
      activePage = pageIndex;
    } else {
      return;
    }

    await component.update(render());
  });

  collector.on("end", async (_collected, reason) => {
    if (reason === "persona_transition") return;
    try {
      await interaction.editReply(render(true));
    } catch (error) {
      log.warn("Failed to disable status dashboard controls after collector ended", {
        errorType: "InteractionEditFailed",
        metadata: { userId: interaction.user.id, error },
      });
    }
  });
}
