import { localizer } from "@/utils/text/localizer";
import { isHostedPolicyEnvironment } from "@/utils/misc/hostedPolicy";

/**
 * Resolves a trailing legal notice for embeds, or an empty string outside the hosted environment.
 *
 * The Terms of Service and Privacy Policy govern the hosted instance, so a locally run bot
 * should not cite them. RUN_ENV is a coarse stand-in: a self-hoster on a VPS also runs
 * production and still sees the notices, accepted here to avoid a second deployment flag. The
 * decision itself lives in `isHostedPolicyEnvironment` so the notice, the wizard's Policies step,
 * and `/legal` leaf registration cannot drift apart.
 *
 * Call sites interpolate the result as a `{legalNotice}` variable placed at the very end of a
 * locale string, so the separator travels with the notice and the sentence leaves no dangling
 * whitespace or blank paragraph when it is omitted.
 *
 * @param separator - Text joining the notice to the preceding copy (`"\n\n"` for its own paragraph).
 */
export function legalNoticeSuffix(locale: string, noticeKey: string, separator = "\n\n"): string {
  if (!isHostedPolicyEnvironment()) {
    return "";
  }

  return `${separator}${localizer(locale, noticeKey)}`;
}
