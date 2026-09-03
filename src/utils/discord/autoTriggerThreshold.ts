export const MIN_THRESHOLD = 0; // 0 means always-reply in configured auto-chat channels
export const MIN_RANDOM_THRESHOLD = 1;
export const MAX_THRESHOLD = 100; // The absolute maximum value allowed

export interface ThresholdValidationResult {
  isValid: boolean;
  isAlwaysReplyMode: boolean;
  isRangeMode: boolean;
}

/**
 * Validates a threshold+max pair and identifies which auto-chat mode applies.
 * (0,0) = always-reply; (n,n) = fixed; (min,max where max>min) = random range.
 */
export function validateThresholdInput(threshold: number, maxThreshold: number): ThresholdValidationResult {
  const isAlwaysReplyMode = threshold === MIN_THRESHOLD && maxThreshold === MIN_THRESHOLD;
  const isRangeMode = threshold >= MIN_RANDOM_THRESHOLD && maxThreshold > threshold;
  const isValid =
    isAlwaysReplyMode ||
    (threshold >= MIN_RANDOM_THRESHOLD &&
      threshold <= MAX_THRESHOLD &&
      maxThreshold >= threshold &&
      maxThreshold <= MAX_THRESHOLD);
  return { isValid, isAlwaysReplyMode, isRangeMode };
}

export function rollAutochatTarget(minThreshold: number, maxThreshold: number): number {
  if (minThreshold <= 0 || maxThreshold <= 0) {
    return 0;
  }

  if (minThreshold === maxThreshold) {
    return minThreshold;
  }

  return Math.floor(Math.random() * (maxThreshold - minThreshold + 1)) + minThreshold;
}
