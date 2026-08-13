import {
  type AddressingStyle,
  EMPTY_PERSONA_NAMING_CONFIG,
  type PersonaNamingConfig,
  type UserPersonaNamingPreference,
} from "@/types/personaNaming";

interface GlobalUserNaming {
  userNickname: string | null;
  prefixOverride: string | null;
  suffixOverride: string | null;
  addressingStyle: AddressingStyle | null;
}

/**
 * Which layer of the precedence chain supplied an affix. `update_user_info` needs
 * it because a global suppression is outranked by a persona-lineage override, so
 * the write would succeed while the affix kept rendering.
 */
type UserAffixSource = "persona_preference" | "global_override" | "persona_default" | "unset";

export interface EffectiveUserNaming {
  nickname: string;
  prefix: string;
  suffix: string;
  prefixSource: UserAffixSource;
  suffixSource: UserAffixSource;
  formattedName: string;
  addressTerm: string;
}

export interface ResolveEffectiveUserNamingInput {
  global: GlobalUserNaming;
  liveDisplayName: string;
  persona?: PersonaNamingConfig;
  preference?: Pick<UserPersonaNamingPreference, "nickname_override" | "prefix_override" | "suffix_override"> | null;
}

function resolvePersonaVariant(values: Partial<Record<AddressingStyle, string>>, style: AddressingStyle): string {
  return values[style] ?? values.neutral ?? "";
}

function resolveAffix(
  personaOverride: string | null | undefined,
  globalOverride: string | null,
  personaValues: Partial<Record<AddressingStyle, string>>,
  style: AddressingStyle,
): { value: string; source: UserAffixSource } {
  if (personaOverride !== null && personaOverride !== undefined) {
    return { value: personaOverride, source: personaOverride ? "persona_preference" : "unset" };
  }
  if (globalOverride !== null) {
    return { value: globalOverride, source: globalOverride ? "global_override" : "unset" };
  }
  const value = resolvePersonaVariant(personaValues, style);
  return { value, source: value ? "persona_default" : "unset" };
}

const CJK_KANA_HANGUL_END =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u303B\u309D\u309E\u30FC\u30FD\u30FE]$/u;
const CJK_KANA_HANGUL_START =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u303B\u309D\u309E\u30FC\u30FD\u30FE]/u;
const PUNCTUATION_OR_SYMBOL_END = /[\p{P}\p{S}]$/u;
const PUNCTUATION_OR_SYMBOL_START = /^[\p{P}\p{S}]/u;

function formatPrefix(prefix: string, nickname: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return nickname;
  if (/\s$/u.test(prefix)) return `${trimmed} ${nickname}`;
  if (PUNCTUATION_OR_SYMBOL_END.test(trimmed) || CJK_KANA_HANGUL_END.test(trimmed)) {
    return `${trimmed}${nickname}`;
  }
  return `${trimmed} ${nickname}`;
}

function formatSuffix(name: string, suffix: string): string {
  const trimmed = suffix.trim();
  if (!trimmed) return name;
  if (/^\s/u.test(suffix)) return `${name} ${trimmed}`;
  if (PUNCTUATION_OR_SYMBOL_START.test(trimmed) || CJK_KANA_HANGUL_START.test(trimmed)) {
    return `${name}${trimmed}`;
  }
  return `${name} ${trimmed}`;
}

function capitalizeLeadingChar(name: string): string {
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

export function formatUserName(nickname: string, prefix = "", suffix = ""): string {
  const normalizedNickname = nickname.trim();
  const assembled = formatSuffix(formatPrefix(prefix, normalizedNickname), suffix);

  // The leading token (prefix if present, else the nickname) always supplies
  // the assembled name's first character. Only capitalize it when that token
  // is entirely lowercase, so a casually-typed prefix like "dad" reads as
  // "Dad Sparrow" while deliberate styling ("@sparrow", "マスター", "xXx...")
  // is left untouched.
  const leadingToken = prefix.trim() || normalizedNickname;
  return leadingToken === leadingToken.toLowerCase() ? capitalizeLeadingChar(assembled) : assembled;
}

export function resolveEffectiveUserNaming(input: ResolveEffectiveUserNamingInput): EffectiveUserNaming {
  const persona = input.persona ?? EMPTY_PERSONA_NAMING_CONFIG;
  const style = input.global.addressingStyle ?? "neutral";
  const nickname =
    input.preference?.nickname_override?.trim() || input.global.userNickname?.trim() || input.liveDisplayName.trim();
  const prefix = resolveAffix(input.preference?.prefix_override, input.global.prefixOverride, persona.prefixes, style);
  const suffix = resolveAffix(input.preference?.suffix_override, input.global.suffixOverride, persona.suffixes, style);

  return {
    nickname,
    prefix: prefix.value,
    suffix: suffix.value,
    prefixSource: prefix.source,
    suffixSource: suffix.source,
    formattedName: formatUserName(nickname, prefix.value, suffix.value),
    addressTerm: resolvePersonaVariant(persona.addressTerms, style),
  };
}
