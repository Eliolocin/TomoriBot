import type { Client } from "discord.js";
import type { TomoriState } from "@/types/db/schema";
import {
  buildPersonalStatusPages,
  type PersonalStatusIdentity,
  type StatusViewerInteraction,
} from "@/utils/metrics/status/personalPages";
import { buildServerChannelPages } from "@/utils/metrics/status/serverChannelPages";
import { buildServerConfigPages } from "@/utils/metrics/status/serverConfigPages";
import { buildServerModelPages } from "@/utils/metrics/status/serverModelPages";
import type { StatusPageCategory } from "@/utils/metrics/status/statusPageRenderer";

export interface StatusDashboardBuildDependencies {
  buildServerChannelPages: typeof buildServerChannelPages;
  buildServerConfigPages: typeof buildServerConfigPages;
  buildServerModelPages: typeof buildServerModelPages;
  buildPersonalStatusPages: typeof buildPersonalStatusPages;
}

const defaultDependencies: StatusDashboardBuildDependencies = {
  buildServerChannelPages,
  buildServerConfigPages,
  buildServerModelPages,
  buildPersonalStatusPages,
};

export async function resolveStatusDashboardCategories(
  client: Client,
  interaction: StatusViewerInteraction,
  userData: PersonalStatusIdentity,
  serverDiscId: string,
  tomoriState: TomoriState,
  locale: string,
  dependencies: StatusDashboardBuildDependencies = defaultDependencies,
): Promise<StatusPageCategory[]> {
  const [configPages, modelPages, channelPages, personalPages] = await Promise.all([
    dependencies.buildServerConfigPages(client, tomoriState, locale),
    dependencies.buildServerModelPages(client, serverDiscId, tomoriState, locale),
    dependencies.buildServerChannelPages(client, serverDiscId, tomoriState, locale),
    dependencies.buildPersonalStatusPages(interaction, userData, locale),
  ]);

  const categories: StatusPageCategory[] = [
    {
      id: "persona",
      labelKey: "commands.status.scope_choice_persona",
      pages: [],
    },
    {
      id: "behavior",
      labelKey: "commands.status.scope_choice_behavior",
      pages: [configPages[0], configPages[3], channelPages[0]],
    },
    {
      id: "models",
      labelKey: "commands.status.scope_choice_models",
      pages: [modelPages[0], modelPages[1], modelPages[3], configPages[4]],
    },
    {
      id: "access",
      labelKey: "commands.status.scope_choice_access",
      pages: [configPages[1], configPages[2], modelPages[2]],
    },
    {
      id: "personal",
      labelKey: "commands.status.scope_choice_personal",
      pages: personalPages,
    },
  ];

  return categories;
}
