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

export interface EffectiveUserNaming {
  nickname: string;
  prefix: string;
  suffix: string;
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

/**
 * Presence, not truthiness, stops the chain: an empty string is a deliberate
 * suppression written by `update_user_info`, so it must outrank the layers below
 * it rather than falling through to the persona's own affix.
 */
function resolveAffix(
  personaOverride: string | null | undefined,
  globalOverride: string | null,
  personaValues: Partial<Record<AddressingStyle, string>>,
  style: AddressingStyle,
): string {
  if (personaOverride !== null && personaOverride !== undefined) return personaOverride;
  if (globalOverride !== null) return globalOverride;
  return resolvePersonaVariant(personaValues, style);
}

const CJK_KANA_HANGUL_END =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u303B\u309D\u309E\u30FC\u30FD\u30FE]$/u;
const CJK_KANA_HANGUL_START =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3005\u303B\u309D\u309E\u30FC\u30FD\u30FE]/u;
const PUNCTUATION_OR_SYMBOL_END = /[\p{P}\p{S}]$/u;
const PUNCTUATION_OR_SYMBOL_START = /^[\p{P}\p{S}]/u;

// Punctuation that closes the prefix into its own word instead of binding it to what
// follows, so an abbreviation or interjection keeps its space: "Ms. Sparrow", "Yo! Sparrow".
// Everything else punctuation-ended still joins directly, which is what "@sparrow",
// "O'Sparrow", and "super-Sparrow" need.
const PREFIX_TERMINAL_PUNCTUATION_END = /[.,;:!?]$/u;

function formatPrefix(prefix: string, nickname: string): string {
  const trimmed = prefix.trim();
  if (!trimmed) return nickname;
  if (/\s$/u.test(prefix)) return `${trimmed} ${nickname}`;
  if (PREFIX_TERMINAL_PUNCTUATION_END.test(trimmed)) return `${trimmed} ${nickname}`;
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
    prefix,
    suffix,
    formattedName: formatUserName(nickname, prefix, suffix),
    addressTerm: resolvePersonaVariant(persona.addressTerms, style),
  };
}
