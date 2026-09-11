/**
 * Structural repair for JSON that a streaming provider truncated mid-payload.
 *
 * OpenAI-compatible endpoints deliver tool arguments as a token stream, so a proxy
 * timeout, a socket reset, or one missing delta leaves an argument string that never
 * closes its last string, object, or array. Plain `JSON.parse` rejects that payload
 * whole, which discards every key the model already emitted in full.
 *
 * The repair is structural: it drops the one incomplete trailing fragment and closes the
 * containers still open. It never invents content and never edits a complete string, so
 * the result stays faithful to what the model generated. A half-written value is dropped
 * rather than quote-closed, because a fabricated closing quote hands the caller a
 * truncated value it cannot tell apart from a real one.
 *
 * A payload the scan cannot balance exactly returns `null`, so the caller keeps its
 * existing failure path.
 */

/** Runaway-input ceiling; a larger argument blob is a caller bug, not a truncation. */
const MAX_REPAIR_INPUT_CHARS = Number.parseInt(process.env.BOT_JSON_REPAIR_MAX_CHARS ?? "1048576", 10);
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
  let literal = "";
  let literalIndex = 0;

  const currentFrame = (): RepairFrame | null => (frames.length > 0 ? frames[frames.length - 1] : null);

  const recordValue = (end: number): void => {
    const frame = currentFrame();
    if (!frame) {
      topLevelValueComplete = true;
      return;
    }
    frame.completeEnd = end;
    frame.hasAnyEntry = true;
    frame.hasCompleteEntry = true;
    frame.state = "separator";
  };

  const markInvalid = (offset: number): void => {
    breakOffset = offset;
    sawBreak = true;
  };

  const stop = (): RepairScan => ({ frames, breakOffset, stoppedInValue: false, scanComplete: false });

  /** Reports a value that never finished, whose fragment is removable from the input. */
  const stopInValue = (offset: number): RepairScan => {
    sawBreak = true;
    return { frames, breakOffset: offset, stoppedInValue: true, scanComplete: false };
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
        frame.hasAnyEntry = true;
        frame.state = "colon";
      } else {
        recordValue(cursor + 1);
      }

      i = cursor;
      continue;
    }

    if (char === ":") {
      const frame = currentFrame();
      if (!frame?.isObject || frame.state !== "colon") {
        markInvalid(i);
        return stop();
      }
      frame.state = "value";
      continue;
    }

    if (char === ",") {
      const frame = currentFrame();
      // A comma separates entries, so it may only follow a complete one.
      if (!frame || frame.state !== "separator") {
        markInvalid(i);
        return stop();
      }
      frame.state = frame.isObject ? "key" : "value";
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
        hasAnyEntry: false,
        hasCompleteEntry: false,
      });
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
      // A closer consumes the entry before it, so that value completes in the parent frame.
      recordValue(i + 1);
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

  return { frames, breakOffset, stoppedInValue: false, scanComplete };
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

  // Walk outward until the frame can be closed without inventing anything. A frame with a
  // finished value that nothing is waiting on is clean, and so is one whose last entry can
  // simply be dropped: either it never started (an object holding only its opening brace)
  // or it finished earlier entries this frame can still close at. A pending *container* is
  // the one case that has to go, because closing it at its opening delimiter is what would
  // put half a list into someone's memory.
  let closingFrom = scan.frames.length;
  while (closingFrom > 0) {
    const frame = scan.frames[closingFrom - 1];
    if (isFrameClean(frame) || (isEntryPending(frame) && (frame.isObject || frame.hasCompleteEntry))) {
      break;
    }
    closingFrom -= 1;
  }

  if (closingFrom === 0) {
    // No frame has anything to close around, so a brand-new empty container is all the
    // payload can support.
    const empty = assemblePrefix(input, scan.frames[0].start + 1, [scan.frames[0].isObject ? "}" : "]"]);
    return tryParseCandidate(empty) ? empty : null;
  }

  const anchor = scan.frames[closingFrom - 1];
  // A pending entry is dropped wholesale, so the offset is the last value the frame
  // finished; a fresh empty object has none, and closes at its opening brace instead.
  const resumeOffset = anchor.hasCompleteEntry ? anchor.completeEnd : anchor.start + 1;
  return finishRepair(input, scan, closingFrom, resumeOffset, passes);
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
