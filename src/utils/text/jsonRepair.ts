/**
 * Structural repair for JSON that a streaming provider truncated mid-payload.
 *
 * OpenAI-compatible endpoints deliver tool arguments as a token stream, so a proxy
 * timeout, a socket reset, or one missing delta leaves an argument string that never
 * closes its last string, object, or array. Plain `JSON.parse` rejects that payload
 * whole, which discards every key the model already emitted in full.
 *
 * The repair is structural: it drops the incomplete trailing fragment and closes the
 * containers still open. It never invents content and never edits a complete token, so the
 * result stays faithful to what the model generated. A value that was cut mid-token is
 * dropped rather than closed, because a fabricated ending hands the caller a value it cannot
 * tell apart from a real one. That applies to numbers as much as to strings: `12345` cut out
 * of `123456` is a different number, not a prefix a caller can recognise as damaged.
 *
 * A payload the scan cannot balance exactly returns `null`, so the caller keeps its
 * existing failure path.
 */

import { parseIntegerEnvFlag } from "@/utils/misc/envFlags";

/** Runaway-input ceiling; a larger argument blob is a caller bug, not a truncation. */
const MAX_REPAIR_INPUT_CHARS = parseIntegerEnvFlag(process.env.BOT_JSON_REPAIR_MAX_CHARS, 1048576, 1024);
/** Bounds the retry loop so a pathological payload can never spin. */
const MAX_REPAIR_PASSES = 64;

/** Leading JSON number grammar, including the sign and exponent forms. */
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/**
 * What a frame accepts next. An array reuses `value` for both its first element and every
 * element after a separator, since an element needs no key in between.
 */
type FrameState = "key" | "colon" | "value" | "separator";

interface RepairFrame {
  /** Index of the opening `{` or `[`. */
  start: number;
  /** Object frames reject bare values, since every entry needs a key. */
  isObject: boolean;
  state: FrameState;
  /** End offset of the last value that finished inside this frame. */
  completeEnd: number;
  /**
   * End offset of the last entry that finished, or the frame's opening delimiter when that
   * entry is the frame's first. An entry ends where its value does, so this is the boundary
   * a pending entry is dropped at: everything after it belongs to the entry that never
   * arrived.
   */
  lastEntryEnd: number;
  /** End offset of the value being read, once that value is the one completing its entry. */
  entryCompletedEnd: number;
  /** Whether any entry or key was read here, which is what separates `{}` from `{`. */
  hasAnyEntry: boolean;
  /** Whether any value finished here, which is what makes the frame safe to close. */
  hasCompleteEntry: boolean;
}

interface RepairScan {
  frames: RepairFrame[];
  /**
   * Offset worth resuming from, which is either the offending token or, when the payload
   * stopped partway through a value, the quote or keyword that value started at.
   */
  breakOffset: number;
  /**
   * True when the break landed inside a value rather than on a token that cannot follow.
   * Such a fragment is removable and everything before it is still structurally sound.
   */
  stoppedInValue: boolean;
  /**
   * Offset just past a number that may have been the last token the stream delivered. A
   * number cut at a delta boundary is indistinguishable from a complete one, so it is kept
   * only when something follows it that proves it ended.
   */
  trailingNumberEnd: number | null;
  /** True when the whole input was consumed, so the break is exhaustion, not malformation. */
  scanComplete: boolean;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

function closerMatchesOpening(opening: string, closer: string): boolean {
  return opening === "{" ? closer === "}" : closer === "]";
}

/** Literal keyword a character starts, or `null` when it starts no keyword. */
function literalFor(char: string): string | null {
  if (char === "t") return "true";
  if (char === "f") return "false";
  if (char === "n") return "null";
  return null;
}

/**
 * Walks the payload once, recording for each frame the offset at which its last value
 * finished. Truncation repair is then a matter of re-emitting the input up to the
 * innermost such offset and closing whatever is still open.
 */
function scanTruncatedJson(input: string): RepairScan {
  const frames: RepairFrame[] = [];
  let topLevelValueComplete = false;
  let breakOffset = input.length;
  let sawBreak = false;
  let lastNumberEnd: number | null = null;
  let literal = "";
  let literalIndex = 0;

  const currentFrame = (): RepairFrame | null => (frames.length > 0 ? frames[frames.length - 1] : null);

  const recordValue = (end: number): void => {
    const frame = currentFrame();
    if (!frame) {
      topLevelValueComplete = true;
      return;
    }
    // The frame's own delimiter is its floor until an entry ends here, which is what keeps
    // the drop offset of a frame holding nothing from pointing into an entry it never had.
    frame.entryCompletedEnd = Math.max(frame.entryCompletedEnd, end);
    frame.completeEnd = end;
    frame.hasAnyEntry = true;
    frame.hasCompleteEntry = true;
    frame.state = "separator";
  };

  /**
   * Records where the entry that just finished closed. An array element is always an entry
   * of its own; an object entry only counts once its value is in.
   */
  const settleEntry = (frame: RepairFrame): void => {
    if (frame.state === "separator" || (!frame.isObject && frame.state === "value")) {
      frame.lastEntryEnd = Math.max(frame.lastEntryEnd, frame.entryCompletedEnd);
    }
  };

  const markInvalid = (offset: number): void => {
    breakOffset = offset;
    sawBreak = true;
  };

  const stop = (): RepairScan => ({
    frames,
    breakOffset,
    stoppedInValue: false,
    trailingNumberEnd: null,
    scanComplete: false,
  });

  /** Reports a value that never finished, whose fragment is removable from the input. */
  const stopInValue = (offset: number): RepairScan => {
    sawBreak = true;
    return { frames, breakOffset: offset, stoppedInValue: true, trailingNumberEnd: null, scanComplete: false };
  };

  /**
   * Any structural character after a number proves the number ended where its digits say,
   * so only another value or the end of the input may follow one for it to stay ambiguous.
   */
  const observesStructuralCharacter = (): void => {
    lastNumberEnd = null;
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (literal) {
      if (char === literal[literalIndex]) {
        literalIndex += 1;
        if (literalIndex === literal.length) {
          recordValue(i + 1);
          literal = "";
        }
        continue;
      }
      markInvalid(i - literalIndex);
      return stop();
    }

    if (isWhitespace(char)) continue;

    if (char === '"') {
      const frame = currentFrame();
      // Inside an array a string is always the entry itself; inside an object it is the
      // key until the colon that pairs it, and the value only afterwards.
      const isKey = frame?.isObject === true && frame.state !== "value";
      const stringStart = i;
      // Scanned with its own cursor so `\"` skips both characters; `continue` here would
      // advance the outer loop as well and step over the terminating quote.
      let cursor = i + 1;
      let closed = false;
      while (cursor < input.length) {
        const stringChar = input[cursor];
        if (stringChar === "\\") {
          cursor += 2;
          continue;
        }
        if (stringChar === '"') {
          closed = true;
          break;
        }
        cursor += 1;
      }

      if (!closed) {
        return stopInValue(stringStart);
      }

      if (!frame) {
        topLevelValueComplete = true;
      } else if (isKey) {
        // A key opens the next entry, so the value before it is the last one that finished.
        settleEntry(frame);
        frame.hasAnyEntry = true;
        frame.state = "colon";
      } else {
        recordValue(cursor + 1);
      }

      i = cursor;
      // A string read as a value proves an earlier number ended; one read as a key starts a
      // new entry instead, so the number before it stays the last value seen.
      if (!isKey) observesStructuralCharacter();
      continue;
    }

    if (char === ":") {
      const frame = currentFrame();
      if (!frame?.isObject || frame.state !== "colon") {
        markInvalid(i);
        return stop();
      }
      frame.state = "value";
      observesStructuralCharacter();
      continue;
    }

    if (char === ",") {
      const frame = currentFrame();
      // A comma separates entries, so it may only follow a complete one.
      if (!frame || frame.state !== "separator") {
        markInvalid(i);
        return stop();
      }
      settleEntry(frame);
      frame.state = frame.isObject ? "key" : "value";
      observesStructuralCharacter();
      continue;
    }

    if (char === "{" || char === "[") {
      const frame = currentFrame();
      if (frame && !isValuePositionAllowed(frame)) {
        markInvalid(i);
        return stop();
      }
      frames.push({
        start: i,
        isObject: char === "{",
        state: char === "{" ? "key" : "value",
        completeEnd: i,
        lastEntryEnd: i,
        entryCompletedEnd: i,
        hasAnyEntry: false,
        hasCompleteEntry: false,
      });
      observesStructuralCharacter();
      continue;
    }

    if (char === "}" || char === "]") {
      const frame = currentFrame();
      if (!frame || !closerMatchesOpening(frame.isObject ? "{" : "[", char)) {
        markInvalid(i);
        return stop();
      }
      // A closer only fits where an entry may end: an object takes one after a complete
      // value, or instead of a first key; an array takes one after a value, or at the
      // separator following one. Anywhere else (say `{"a": }` or `[,1]`) the payload is
      // malformed rather than truncated, so the repair refuses it.
      const closesEntry = frame.isObject
        ? frame.state === "key" || frame.state === "colon" || frame.state === "separator"
        : frame.state === "value" || frame.state === "separator";
      if (!closesEntry) {
        markInvalid(i);
        return stop();
      }
      frames.pop();
      // A closer consumes the entry before it, so that entry ended where the value did. The
      // closer's own position then completes the parent entry carrying this container.
      settleEntry(frame);
      recordValue(i + 1);
      observesStructuralCharacter();
      continue;
    }

    if (char === "-" || (char >= "0" && char <= "9")) {
      const frame = currentFrame();
      if (frame && !isValuePositionAllowed(frame)) {
        markInvalid(i);
        return stop();
      }
      const numeric = NUMBER_PATTERN.exec(input.slice(i))?.[0];
      if (!numeric) {
        // A lone minus is the one number fragment a truncation can leave behind, since
        // every other prefix of a JSON number parses on its own.
        if (input.slice(i).trim() === "-") {
          return stopInValue(i);
        }
        markInvalid(i);
        return stop();
      }
      i += numeric.length - 1;
      recordValue(i + 1);
      lastNumberEnd = i + 1;
      continue;
    }

    const keyword = literalFor(char);
    if (keyword) {
      const frame = currentFrame();
      if (frame && !isValuePositionAllowed(frame)) {
        markInvalid(i);
        return stop();
      }
      literal = keyword;
      literalIndex = 1;
      observesStructuralCharacter();
      continue;
    }

    markInvalid(i);
    return stop();
  }

  // Reaching the end of the input means the provider stopped sending, which is a
  // truncation; every earlier exit above found a token that cannot follow.
  const scanComplete = !sawBreak;
  if (scanComplete && topLevelValueComplete && frames.length === 0) {
    // A complete top-level value is valid JSON, so `JSON.parse` owns the outcome.
    breakOffset = input.length;
  }

  return {
    frames,
    breakOffset,
    stoppedInValue: false,
    trailingNumberEnd: lastNumberEnd,
    scanComplete,
  };
}

/** An object takes a value only after its colon; an array takes one between separators. */
function isValuePositionAllowed(frame: RepairFrame): boolean {
  return frame.isObject ? frame.state === "value" : frame.state === "value" || frame.state === "separator";
}

/** True when the frame holds a finished value and nothing after it is still waiting. */
function isFrameClean(frame: RepairFrame): boolean {
  return frame.hasCompleteEntry && !isEntryPending(frame);
}

/** True when the frame started an entry, or a key, and never received its value. */
function isEntryPending(frame: RepairFrame): boolean {
  return frame.hasAnyEntry && frame.state === "value";
}

/** Re-emits everything before `end`, then appends the delimiters still open. */
function assemblePrefix(input: string, end: number, delimiters: string[]): string {
  let prefix = input.slice(0, end);
  const lastChar = prefix[prefix.length - 1];
  if (lastChar === ",") {
    prefix = prefix.slice(0, -1);
  } else if (isWhitespace(lastChar)) {
    prefix = prefix.replace(/[\s,]+$/, "");
  }
  return `${prefix}${delimiters.join("")}`;
}

/**
 * Closes the containers the truncation left open, dropping the incomplete trailing
 * fragment.
 *
 * Closing starts at the deepest frame that can be closed without inventing anything, so a
 * frame holding a finished value survives even when the entry after it was cut off. Each
 * retry resumes from an earlier offset than the last, which is what makes the recursion
 * finite.
 *
 * @returns A balanced payload, or `null` when no frame holds a value to close around.
 */
function closeOpenContainers(input: string, scan: RepairScan, passes: number): string | null {
  if (passes >= MAX_REPAIR_PASSES || scan.frames.length === 0) {
    return null;
  }

  // A payload that reached its end is truncated, whether it ran out of tokens exactly or
  // stopped partway through a value. Anything else is a token that cannot follow, and no
  // amount of closing can supply the value the payload never produced.
  const truncated = scan.scanComplete || scan.stoppedInValue;
  if (!truncated) {
    return null;
  }

  // A number at the very end of the payload cannot be told apart from a number the provider
  // cut short, and its digits read as exact. Its frame goes back to waiting for a value, so
  // the walk below drops the entry that carried it exactly as it drops a key whose value
  // never arrived, while the entries before it stay in the frame.
  if (scan.trailingNumberEnd !== null) {
    for (const frame of scan.frames) {
      if (frame.completeEnd !== scan.trailingNumberEnd) {
        continue;
      }
      frame.state = "value";
      frame.completeEnd = frame.lastEntryEnd;
      frame.hasAnyEntry = frame.lastEntryEnd > frame.start;
      frame.hasCompleteEntry = frame.lastEntryEnd > frame.start;
    }
  }

  // Walk outward until the frame can be closed without inventing anything. A frame with a
  // finished value that nothing is waiting on is clean, and so is one whose last entry can
  // simply be dropped: either it never started (an object holding only its opening brace)
  // or it finished earlier entries this frame can still close at. A pending *container* is
  // the one case that has to go, because closing it at its opening delimiter is what would
  // put half a list into someone's memory.
  let closingFrom = scan.frames.length;
  while (closingFrom > 0) {
    const frame = scan.frames[closingFrom - 1];
    // A pending frame is closeable only when it has a finished entry to fall back on: the
    // entry waiting for a value is dropped, which needs an earlier one to close around.
    const emptyObject = !frame.hasCompleteEntry && frame.isObject;
    if (isFrameClean(frame) || (isEntryPending(frame) && (emptyObject || frame.hasCompleteEntry))) {
      break;
    }
    closingFrom -= 1;
  }

  if (closingFrom === 0) {
    // Nothing finished inside any frame, so an empty container is all the payload can close.
    // A truncated payload nested one level down held no value at all, which makes an empty
    // read a worse answer than reporting that the repair could not help.
    if (scan.trailingNumberEnd !== null && scan.frames.length > 1) {
      return null;
    }
    const empty = assemblePrefix(input, scan.frames[0].start + 1, [scan.frames[0].isObject ? "}" : "]"]);
    return tryParseCandidate(empty) ? empty : null;
  }

  const anchor = scan.frames[closingFrom - 1];
  // A pending entry is dropped whole, so the offset is the last entry that finished before
  // it. A fresh empty object has none, and closes at its opening brace instead.
  const resumeOffset = emptyFrameResumeOffset(anchor);

  return finishRepair(input, scan, closingFrom, resumeOffset, passes);
}

/** Where a frame closes when the entry it is waiting on has to be dropped. */
function emptyFrameResumeOffset(frame: RepairFrame): number {
  if (!frame.hasCompleteEntry) {
    return frame.start + 1;
  }
  return isEntryPending(frame) ? frame.lastEntryEnd : frame.completeEnd;
}

/**
 * Emits the payload up to `resumeOffset`, closes every frame below `closingFrom`, and
 * retries with the fragment dropped when the result still will not parse.
 */
function finishRepair(
  input: string,
  scan: RepairScan,
  closingFrom: number,
  resumeOffset: number,
  passes: number,
): string | null {
  const end = Math.min(scan.breakOffset, resumeOffset);
  const delimiters = scan.frames
    .slice(0, closingFrom)
    .reverse()
    .map((frame) => (frame.isObject ? "}" : "]"));
  const candidate = assemblePrefix(input, end, delimiters);

  if (tryParseCandidate(candidate)) {
    return candidate;
  }
  if (passes + 1 >= MAX_REPAIR_PASSES) {
    return null;
  }
  // A dangling separator or key can still survive the first cut, so the next pass resumes
  // from the previous entry. Each retry moves `end` earlier, so the recursion terminates.
  return closeOpenContainers(input, { ...scan, breakOffset: end, stoppedInValue: false }, passes + 1);
}

/** Parse probe for a repair candidate, so only a balanced payload is ever returned. */
function tryParseCandidate(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Repairs a truncated JSON object so the keys that arrived complete survive.
 *
 * @returns The repaired object, or `null` when the payload is not repairable or was never
 *          truncated. Callers keep their existing failure path on `null`.
 */
export function tryRepairIncompleteJson(raw: string): Record<string, unknown> | null {
  if (!raw || raw.length > MAX_REPAIR_INPUT_CHARS) {
    return null;
  }

  const scan = scanTruncatedJson(raw);
  if (scan.scanComplete && scan.frames.length === 0) {
    // The payload scanned cleanly, so whatever is wrong with it is not a truncation.
    return null;
  }

  const repaired = closeOpenContainers(raw, scan, 0);
  if (!repaired) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(repaired);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
