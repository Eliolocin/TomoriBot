import { z } from "zod";

const ADDRESSING_STYLES = ["masculine", "feminine", "neutral"] as const;
export const addressingStyleSchema = z.enum(ADDRESSING_STYLES);
export type AddressingStyle = z.infer<typeof addressingStyleSchema>;

export const USER_NICKNAME_MAX_LENGTH = 100;
export const USER_IDENTITY_FIELD_MAX_LENGTH = 200;
export const PERSONA_NAMING_VALUE_MAX_LENGTH = 100;

const namingValueSchema = z
  .string()
  .min(1)
  .max(PERSONA_NAMING_VALUE_MAX_LENGTH)
  .refine((value) => value === value.trim(), "Naming values must not have surrounding whitespace");

const addressingVariantMapSchema = z
  .object({
    masculine: namingValueSchema.optional(),
    feminine: namingValueSchema.optional(),
    neutral: namingValueSchema.optional(),
  })
  .strict();
export const personaNamingConfigSchema = z
  .object({
    prefixes: addressingVariantMapSchema.default({}),
    suffixes: addressingVariantMapSchema.default({}),
    addressTerms: addressingVariantMapSchema.default({}),
  })
  .strict()
  .superRefine((config, context) => {
    const hasGenderedAddressTerm = Boolean(config.addressTerms.masculine || config.addressTerms.feminine);
    if (hasGenderedAddressTerm && !config.addressTerms.neutral) {
      context.addIssue({
        code: "custom",
        path: ["addressTerms", "neutral"],
        message: "A neutral address term is required when a masculine or feminine term is configured",
      });
    }
  });
export type PersonaNamingConfig = z.infer<typeof personaNamingConfigSchema>;

export const EMPTY_PERSONA_NAMING_CONFIG: PersonaNamingConfig = {
  prefixes: {},
  suffixes: {},
  addressTerms: {},
};

export const userPersonaNamingPreferenceSchema = z.object({
  user_id: z.number().int(),
  persona_lineage_id: z.preprocess(
    (value) => (typeof value === "bigint" || typeof value === "string" ? Number(value) : value),
    z.number().int().nonnegative(),
  ),
  nickname_override: z.string().max(USER_NICKNAME_MAX_LENGTH).nullable(),
  prefix_override: z.string().max(PERSONA_NAMING_VALUE_MAX_LENGTH).nullable(),
  suffix_override: z.string().max(PERSONA_NAMING_VALUE_MAX_LENGTH).nullable(),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
export type UserPersonaNamingPreference = z.infer<typeof userPersonaNamingPreferenceSchema>;

export const personaNamingConfigRowSchema = z.object({
  persona_id: z.number().int(),
  prefixes: z.preprocess(parseJsonValue, addressingVariantMapSchema.default({})),
  suffixes: z.preprocess(parseJsonValue, addressingVariantMapSchema.default({})),
  address_terms: z.preprocess(parseJsonValue, addressingVariantMapSchema.default({})),
  created_at: z.date().optional(),
  updated_at: z.date().optional(),
});
function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hasUserTermMacro(text: string): boolean {
  return /\{\{user_term\}\}|\{user_term\}/u.test(text);
}

export function validatePersonaNamingAuthoring(config: PersonaNamingConfig, authoredText: string[]): void {
  if (authoredText.some(hasUserTermMacro) && !config.addressTerms.neutral) {
    throw new Error("A neutral address term is required when persona text uses {user_term}");
  }
}
