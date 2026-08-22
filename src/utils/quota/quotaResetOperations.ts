import {
  resetServerwideImageQuotaPool as defaultResetServerwideImageQuotaPool,
  resetServerwideTextQuotaPool as defaultResetServerwideTextQuotaPool,
  resetServerwideVideoQuotaPool as defaultResetServerwideVideoQuotaPool,
  resetUserDailyImageQuota as defaultResetUserDailyImageQuota,
  resetUserDailyTextQuota as defaultResetUserDailyTextQuota,
  resetUserDailyVideoQuota as defaultResetUserDailyVideoQuota,
} from "@/utils/db/repositories/QuotaRepository";

export type CanonicalQuotaType = "image" | "text" | "video";

export interface ResetUserQuotaInput {
  serverId: number;
  targetUserId: string;
  quotaType: CanonicalQuotaType;
}

export interface ResetGlobalQuotaInput {
  serverId: number;
  quotaType: CanonicalQuotaType;
}

export interface QuotaResetDependencies {
  resetUserDailyImageQuota: (serverId: number, userDiscId: string) => Promise<void>;
  resetUserDailyTextQuota: (serverId: number, userDiscId: string) => Promise<void>;
  resetUserDailyVideoQuota: (serverId: number, userDiscId: string) => Promise<void>;
  resetServerwideImageQuotaPool: (serverId: number) => Promise<void>;
  resetServerwideTextQuotaPool: (serverId: number) => Promise<void>;
  resetServerwideVideoQuotaPool: (serverId: number) => Promise<void>;
}

const defaultDependencies: QuotaResetDependencies = {
  resetUserDailyImageQuota: defaultResetUserDailyImageQuota,
  resetUserDailyTextQuota: defaultResetUserDailyTextQuota,
  resetUserDailyVideoQuota: defaultResetUserDailyVideoQuota,
  resetServerwideImageQuotaPool: defaultResetServerwideImageQuotaPool,
  resetServerwideTextQuotaPool: defaultResetServerwideTextQuotaPool,
  resetServerwideVideoQuotaPool: defaultResetServerwideVideoQuotaPool,
};

export async function resetUserQuota(
  input: ResetUserQuotaInput,
  deps: QuotaResetDependencies = defaultDependencies,
): Promise<void> {
  if (input.quotaType === "image") {
    await deps.resetUserDailyImageQuota(input.serverId, input.targetUserId);
    return;
  }
  if (input.quotaType === "text") {
    await deps.resetUserDailyTextQuota(input.serverId, input.targetUserId);
    return;
  }
  await deps.resetUserDailyVideoQuota(input.serverId, input.targetUserId);
}

export async function resetGlobalQuota(
  input: ResetGlobalQuotaInput,
  deps: QuotaResetDependencies = defaultDependencies,
): Promise<void> {
  if (input.quotaType === "image") {
    await deps.resetServerwideImageQuotaPool(input.serverId);
    return;
  }
  if (input.quotaType === "text") {
    await deps.resetServerwideTextQuotaPool(input.serverId);
    return;
  }
  await deps.resetServerwideVideoQuotaPool(input.serverId);
}

export const quotaResetOperations = {
  resetUserQuota,
  resetGlobalQuota,
};
