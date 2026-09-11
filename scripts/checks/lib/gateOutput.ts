/**
 * Shared quiet/verbose flag for the validation gates.
 *
 * Gates are read far more often by an agent ingesting the whole output than by a
 * human scrolling a terminal, so detail is quiet by default and `--verbose` restores
 * it. The invariant that keeps this from hiding bugs: quiet mode only ever
 * suppresses detail for PASSING and ADVISORY results. A failure always prints its
 * full detail, because that detail is the reason anyone runs the gate.
 */

/**
 * True when the caller asked for the pre-quiet detail.
 *
 * `--no-verbose` wins over `--verbose` so a wrapper (vl) can append `--no-verbose`
 * after a forwarded flag instead of having to strip it back out of the argument list.
 */
export function isVerboseOutput(argv: string[] = process.argv): boolean {
  if (argv.includes("--no-verbose")) return false;
  return argv.includes("--verbose");
}

/**
 * The one-line expansion hint appended to a suppressed advisory summary.
 *
 * Pass the exact command a reader should run, so the hint stays correct for a
 * gate invoked directly and for the same gate invoked through its aggregator.
 */
export function verboseOutputHint(rerunCommand: string): string {
  return `Re-run with \`${rerunCommand} --verbose\` to list them.`;
}
