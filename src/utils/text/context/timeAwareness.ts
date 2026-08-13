import { formatDateWithOffset, getCalendarDayWithOffset, isValidUtcOffset } from "@/utils/text/timezoneHelper";

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const TIME_AWARENESS_REUNION_DAYS = readIntEnv("TIME_AWARENESS_REUNION_DAYS", 7);

/**
 * How many messages deep the reunion note is injected. Depth 1 (the original
 * value) put it directly above the newest message, where it competed with the
 * user's actual prompt for the model's attention; depth 3 matches the verbatim
 * tool-calling nudge and keeps it advisory rather than imperative.
 */
export const TIME_AWARENESS_NOTE_DEPTH = readIntEnv("TIME_AWARENESS_NOTE_DEPTH", 3);

export const SPACER_TEMPLATE =
  "[System: The messages above were sent on {date} ({relative}, server time). Use the {message_metadata_tool} tool to learn the exact times of each message, if needed.]";

export interface BuildReunionNoteArgs {
  lastPreviousDayAt: Date | null;
  seenToday: boolean;
  personalOffset?: number | null;
  serverOffset?: number | null;
  displayName: string;
  nowMs?: number;
  reunionDays?: number;
}

/**
 * Builds the one-shot persona-reunion note as raw text. The dialogue-history
 * consumer wraps it in `[System: ...]`.
 *
 * @returns The note body, or null when no reunion applies to this person.
 */
export function buildReunionNote(args: BuildReunionNoteArgs): string | null {
  const reunionDays = args.reunionDays ?? TIME_AWARENESS_REUNION_DAYS;
  if (args.seenToday) return null;

  const offsetHours = resolvePersonalTimezoneOffset(args.personalOffset, args.serverOffset);

  if (args.lastPreviousDayAt === null) {
    return `${args.displayName} is talking to you directly for the very first time! Welcome them naturally and ask something friendly to get to know them.`;
  }

  const nowMs = args.nowMs ?? Date.now();
  const dayGap =
    getCalendarDayWithOffset(nowMs, offsetHours) -
    getCalendarDayWithOffset(args.lastPreviousDayAt.getTime(), offsetHours);
  if (dayGap < reunionDays) return null;

  const lastDate = formatDateWithOffset(args.lastPreviousDayAt.getTime(), offsetHours);
  return `${args.displayName} hasn't interacted with you specifically since ${lastDate} (${dayGap} days ago), though they may have been around the server. Acknowledge them interacting with you again.`;
}

/**
 * Builds a separator for a server-calendar-day boundary. The tool macro must
 * already be expanded by the caller; this function only fills date fields.
 */
export function buildDateSpacer(
  prevCreatedAt: number,
  nextCreatedAt: number,
  serverOffset: number | null | undefined,
  expandedTemplate: string,
  nowMs = Date.now(),
): string | null {
  const offsetHours = isValidUtcOffset(serverOffset) ? serverOffset : 0;
  const previousDay = getCalendarDayWithOffset(prevCreatedAt, offsetHours);
  const nextDay = getCalendarDayWithOffset(nextCreatedAt, offsetHours);
  if (previousDay === nextDay) return null;

  const dayGap = getCalendarDayWithOffset(nowMs, offsetHours) - previousDay;
  return expandedTemplate
    .replaceAll("{date}", formatDateWithOffset(prevCreatedAt, offsetHours))
    .replaceAll("{relative}", formatRelativeDay(dayGap));
}

function resolvePersonalTimezoneOffset(personalOffset?: number | null, serverOffset?: number | null): number {
  if (isValidUtcOffset(personalOffset)) return personalOffset;
  if (isValidUtcOffset(serverOffset)) return serverOffset;
  return 0;
}

function formatRelativeDay(dayGap: number): string {
  if (dayGap === 0) return "today";
  if (dayGap === 1) return "yesterday";
  if (dayGap > 1) return `${dayGap} days ago`;
  if (dayGap === -1) return "tomorrow";
  return `${Math.abs(dayGap)} days from now`;
}
