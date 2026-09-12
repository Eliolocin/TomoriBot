import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextDisplayBuilder,
  type ActionRowData,
  type ButtonComponentData,
  type ComponentInContainerData,
  type ContainerComponentData,
  type StringSelectMenuComponentData,
  type TopLevelComponentData,
} from "discord.js";
import {
  HELP_CATEGORIES,
  getHelpCategory,
  getHelpPage,
  getHelpVariant,
  type HelpCategoryDefinition,
  type HelpCategoryId,
  type HelpPageDefinition,
  type HelpPageId,
  type HelpVariantDefinition,
} from "@/utils/discord/helpCatalog";
import {
  PROVIDER_GUIDES,
  getProviderGuide,
  getProviderGuideVariables,
  type HelpProviderId,
} from "@/utils/discord/helpProviderGuides";
import { SUPPORT_SERVER_URL, buildDocsUrl } from "@/utils/discord/docsLinks";
import { localizer } from "@/utils/text/localizer";

const TOMORI_TURQUOISE = 0x65c6c5;
const MODAL_TEXT_DISPLAY_LIMIT = 4_000;
const MODAL_COMPONENT_LIMIT = 5;

export const HELP_ROUTE_NAMESPACE = "help";
export const HELP_ROUTE_VERSION = "v2";

export interface HelpSelection {
  category: HelpCategoryDefinition;
  page: HelpPageDefinition;
  variant?: HelpVariantDefinition;
}

export interface HelpStop {
  pageId: HelpPageId;
  variantId?: string;
}

export interface HelpDashboardPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
}

export function buildHelpStops(category: HelpCategoryDefinition): HelpStop[] {
  const stops: HelpStop[] = [];
  for (const page of category.pages) {
    if (page.variants && page.variants.length > 0) {
      for (const variant of page.variants) {
        stops.push({ pageId: page.id, variantId: variant.id });
      }
    } else {
      stops.push({ pageId: page.id });
    }
  }
  return stops;
}

export function buildHelpCustomId(...segments: string[]): string {
  return [HELP_ROUTE_NAMESPACE, HELP_ROUTE_VERSION, ...segments].join(":");
}

export function resolveHelpSelection(categoryId?: string, pageId?: string, variantId?: string): HelpSelection {
  const category = getHelpCategory(categoryId ?? "") ?? HELP_CATEGORIES[0];
  const page = getHelpPage(category, pageId ?? "") ?? category.pages[0];
  return {
    category,
    page,
    variant: getHelpVariant(page, variantId),
  };
}

function buildCategoryRow(locale: string, activeCategoryId: HelpCategoryId): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: HELP_CATEGORIES.map((category) => ({
      type: ComponentType.Button,
      style: category.id === activeCategoryId ? ButtonStyle.Primary : ButtonStyle.Secondary,
      customId: buildHelpCustomId("category", locale, category.id),
      label: localizer(locale, category.labelKey),
      disabled: category.id === activeCategoryId,
    })),
  };
}

function buildPageSelectRow(
  locale: string,
  category: HelpCategoryDefinition,
  activePageId: HelpPageId,
): ActionRowData<StringSelectMenuComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildHelpCustomId("page", locale, category.id),
        placeholder: localizer(locale, "commands.help.dashboard.page_select_placeholder"),
        minValues: 1,
        maxValues: 1,
        options: category.pages.map((page) => ({
          label: localizer(locale, page.labelKey),
          value: page.id,
          default: page.id === activePageId,
        })),
      },
    ],
  };
}

function buildNavigationRow(
  locale: string,
  category: HelpCategoryDefinition,
  stops: readonly HelpStop[],
  stopIndex: number,
): ActionRowData<ButtonComponentData> {
  const safeIndex = Math.max(0, Math.min(stops.length - 1, stopIndex));
  const previousStop = stops[Math.max(0, safeIndex - 1)];
  const nextStop = stops[Math.min(stops.length - 1, safeIndex + 1)];

  const buildNavigateCustomId = (stop: HelpStop): string => {
    return stop.variantId
      ? buildHelpCustomId("navigate", locale, category.id, stop.pageId, stop.variantId)
      : buildHelpCustomId("navigate", locale, category.id, stop.pageId);
  };

  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildNavigateCustomId(previousStop),
        label: localizer(locale, "commands.help.dashboard.previous_button"),
        disabled: safeIndex === 0,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildNavigateCustomId(nextStop),
        label: localizer(locale, "commands.help.dashboard.next_button"),
        disabled: safeIndex === stops.length - 1,
      },
    ],
  };
}

function buildProviderSelectRow(locale: string): ActionRowData<StringSelectMenuComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildHelpCustomId("provider", locale),
        placeholder: localizer(locale, "commands.help.dashboard.provider_select_placeholder"),
        minValues: 1,
        maxValues: 1,
        options: PROVIDER_GUIDES.map((provider) => ({
          label: localizer(locale, provider.labelKey),
          description: localizer(locale, provider.pickerDescriptionKey),
          value: provider.id,
        })),
      },
    ],
  };
}

function buildVariantSelectRow(
  locale: string,
  category: HelpCategoryDefinition,
  page: HelpPageDefinition,
  activeVariantId?: string,
): ActionRowData<StringSelectMenuComponentData> | undefined {
  if (!page.variants) {
    return undefined;
  }
  const selectedVariantId = activeVariantId ?? page.variants[0].id;
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.StringSelect,
        customId: buildHelpCustomId("variant", locale, category.id, page.id),
        placeholder: localizer(locale, "commands.help.dashboard.guide_select_placeholder"),
        minValues: 1,
        maxValues: 1,
        options: page.variants.map((variant) => ({
          label: localizer(locale, variant.labelKey),
          value: variant.id,
          default: variant.id === selectedVariantId,
        })),
      },
    ],
  };
}

function buildPersistentFooterRow(
  locale: string,
  docsPath: HelpPageDefinition["docsPath"],
): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Link,
        label: localizer(locale, "commands.help.dashboard.docs_link_label"),
        url: buildDocsUrl(docsPath),
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Link,
        label: localizer(locale, "commands.help.dashboard.support_link_label"),
        url: SUPPORT_SERVER_URL,
      },
    ],
  };
}

export function buildHelpDashboardPayload(
  locale: string,
  categoryId?: string,
  pageId?: string,
  variantId?: string,
): HelpDashboardPayload {
  const { category, page, variant } = resolveHelpSelection(categoryId, pageId, variantId);
  const activeVariant = variant ?? page.variants?.[0];
  const pageVariables = page.variables?.(locale) ?? {};
  const content: ComponentInContainerData[] = [
    buildCategoryRow(locale, category.id),
    { type: ComponentType.Separator, divider: true, spacing: 1 },
  ];

  if (page.introTitleKey && page.introDescriptionKey) {
    content.push({
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, page.introTitleKey, pageVariables)}\n${localizer(locale, page.introDescriptionKey, pageVariables)}`,
    });
  }

  content.push({
    type: ComponentType.TextDisplay,
    content: `${"#".repeat(page.titleHeadingLevel ?? 2)} ${localizer(locale, page.titleKey, pageVariables)}\n${localizer(locale, page.descriptionKey, pageVariables)}`,
  });

  if (activeVariant) {
    const variantVariables = { ...pageVariables, ...activeVariant.variables?.(locale) };
    content.push({
      type: ComponentType.TextDisplay,
      content: `### ${localizer(locale, activeVariant.titleKey, variantVariables)}\n${localizer(locale, activeVariant.descriptionKey, variantVariables)}`,
    });

    for (const section of activeVariant.sections) {
      const sectionVariables = { ...variantVariables, ...section.variables?.(locale) };
      content.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, section.titleKey, sectionVariables)}\n${localizer(locale, section.bodyKey, sectionVariables)}`,
      });
    }

    if (activeVariant.footerKey) {
      content.push({
        type: ComponentType.TextDisplay,
        content: `-# ${localizer(locale, activeVariant.footerKey, variantVariables)}`,
      });
    }
  } else {
    for (const section of page.sections) {
      const sectionVariables = { ...pageVariables, ...section.variables?.(locale) };
      content.push({
        type: ComponentType.TextDisplay,
        content: `### ${localizer(locale, section.titleKey, sectionVariables)}\n${localizer(locale, section.bodyKey, sectionVariables)}`,
      });
    }

    if (page.footerKey) {
      content.push({
        type: ComponentType.TextDisplay,
        content: `-# ${localizer(locale, page.footerKey, pageVariables)}`,
      });
    }
  }

  if (page.showProviderPicker) {
    content.push(buildProviderSelectRow(locale));
    if (page.providerPickerFooterKey) {
      content.push({
        type: ComponentType.TextDisplay,
        content: localizer(locale, page.providerPickerFooterKey, pageVariables),
      });
    }
  }

  const variantSelect = buildVariantSelectRow(locale, category, page, activeVariant?.id);
  if (variantSelect) {
    content.push(variantSelect);
  }

  const stops = buildHelpStops(category);
  const currentStopIndex = stops.findIndex((stop) => stop.pageId === page.id && stop.variantId === activeVariant?.id);

  content.push(
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    buildPageSelectRow(locale, category, page.id),
    buildNavigationRow(locale, category, stops, Math.max(0, currentStopIndex)),
  );

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: TOMORI_TURQUOISE,
    components: content,
  };
  return {
    components: [container, buildPersistentFooterRow(locale, activeVariant?.docsPath ?? page.docsPath)],
    flags: MessageFlags.IsComponentsV2,
  };
}

function splitModalContent(content: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of content.split("\n\n")) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= MODAL_TEXT_DISPLAY_LIMIT) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }
    for (let offset = 0; offset < paragraph.length; offset += MODAL_TEXT_DISPLAY_LIMIT) {
      chunks.push(paragraph.slice(offset, offset + MODAL_TEXT_DISPLAY_LIMIT));
    }
  }
  if (current) {
    chunks.push(current);
  }
  if (chunks.length > MODAL_COMPONENT_LIMIT) {
    throw new Error("Provider help exceeds Discord's modal component limit");
  }
  return chunks;
}

export function buildProviderGuideModal(locale: string, providerId: HelpProviderId): ModalBuilder {
  const guide = getProviderGuide(providerId);
  const variables = getProviderGuideVariables(locale);
  const blocks = [
    `## ${localizer(locale, guide.titleKey, variables)}`,
    localizer(locale, guide.descriptionKey, variables),
    ...guide.sections.map(
      (section) =>
        `**${localizer(locale, section.titleKey, variables)}**\n${localizer(locale, section.bodyKey, variables)}`,
    ),
    ...(guide.footerKey ? [`-# ${localizer(locale, guide.footerKey, variables)}`] : []),
    `-# [${localizer(locale, "commands.help.dashboard.docs_link_label")}](<${buildDocsUrl(guide.docsPath)}>)`,
  ];

  const modal = new ModalBuilder()
    .setCustomId(buildHelpCustomId("provider-modal", locale, guide.id))
    .setTitle(localizer(locale, guide.labelKey).slice(0, 45));
  modal.addTextDisplayComponents(
    ...splitModalContent(blocks.join("\n\n")).map((content) => new TextDisplayBuilder().setContent(content)),
  );
  return modal;
}
