/**
 * The hosted Terms of Service and Privacy Policy govern only the hosted instance, so a self-hosted
 * bot renders no policy step.
 */
export function isHostedPolicyEnvironment(): boolean {
  return process.env.RUN_ENV === "production";
}
