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

const HELP_ACCENT_COLOR = 0x5865f2;
const MODAL_TEXT_DISPLAY_LIMIT = 4_000;
const MODAL_COMPONENT_LIMIT = 5;

export const HELP_ROUTE_NAMESPACE = "help";
export const HELP_ROUTE_VERSION = "v1";

export interface HelpSelection {
  category: HelpCategoryDefinition;
  page: HelpPageDefinition;
  pageIndex: number;
  variant?: HelpVariantDefinition;
}

export interface HelpDashboardPayload {
  components: TopLevelComponentData[];
  flags: MessageFlags.IsComponentsV2;
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
    pageIndex: category.pages.findIndex((candidate) => candidate.id === page.id),
    variant: getHelpVariant(page, variantId),
  };
}

function buildCategoryRow(locale: string, activeCategoryId: HelpCategoryId): ActionRowData<ButtonComponentData> {
  return {
    type: ComponentType.ActionRow,
    components: HELP_CATEGORIES.map((category) => ({
      type: ComponentType.Button,
      style: category.id === activeCategoryId ? ButtonStyle.Success : ButtonStyle.Secondary,
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
  pageIndex: number,
): ActionRowData<ButtonComponentData> {
  const previousPage = category.pages[Math.max(0, pageIndex - 1)];
  const nextPage = category.pages[Math.min(category.pages.length - 1, pageIndex + 1)];
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildHelpCustomId("navigate", locale, category.id, previousPage.id),
        label: localizer(locale, "commands.help.dashboard.previous_button"),
        disabled: pageIndex === 0,
      },
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        customId: buildHelpCustomId("navigate", locale, category.id, nextPage.id),
        label: localizer(locale, "commands.help.dashboard.next_button"),
        disabled: pageIndex === category.pages.length - 1,
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

function buildPersistentFooter(locale: string, docsPath: HelpPageDefinition["docsPath"]): string {
  return [
    `-# [${localizer(locale, "commands.help.dashboard.docs_link_label")}](<${buildDocsUrl(docsPath)}>)`,
    `-# [${localizer(locale, "commands.help.dashboard.support_link_label")}](<${SUPPORT_SERVER_URL}>)`,
  ].join("\n");
}

export function buildHelpDashboardPayload(
  locale: string,
  categoryId?: string,
  pageId?: string,
  variantId?: string,
): HelpDashboardPayload {
  const { category, page, pageIndex, variant } = resolveHelpSelection(categoryId, pageId, variantId);
  const activeContent = variant ?? page.variants?.[0] ?? page;
  const variables = activeContent.variables?.(locale) ?? {};
  const content: ComponentInContainerData[] = [
    buildCategoryRow(locale, category.id),
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    {
      type: ComponentType.TextDisplay,
      content: `## ${localizer(locale, activeContent.titleKey, variables)}\n${localizer(locale, activeContent.descriptionKey, variables)}`,
    },
  ];

  for (const section of activeContent.sections) {
    const sectionVariables = { ...variables, ...section.variables?.(locale) };
    content.push({
      type: ComponentType.TextDisplay,
      content: `**${localizer(locale, section.titleKey, sectionVariables)}**\n${localizer(locale, section.bodyKey, sectionVariables)}`,
    });
  }

  if (activeContent.footerKey) {
    content.push({
      type: ComponentType.TextDisplay,
      content: `-# ${localizer(locale, activeContent.footerKey, variables)}`,
    });
  }

  if (page.showProviderPicker) {
    content.push(buildProviderSelectRow(locale));
  }

  const variantSelect = buildVariantSelectRow(locale, category, page, variant?.id);
  if (variantSelect) {
    content.push(variantSelect);
  }

  content.push(
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    buildPageSelectRow(locale, category, page.id),
    buildNavigationRow(locale, category, pageIndex),
    { type: ComponentType.Separator, divider: true, spacing: 1 },
    { type: ComponentType.TextDisplay, content: buildPersistentFooter(locale, activeContent.docsPath) },
  );

  const container: ContainerComponentData<ComponentInContainerData> = {
    type: ComponentType.Container,
    accentColor: HELP_ACCENT_COLOR,
    components: content,
  };
  return {
    components: [container],
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
