/**
 * The hosted Terms of Service and Privacy Policy govern only the hosted instance, so a self-hosted
 * bot renders no policy step and registers no legal leaf that cites them.
 *
 * Read `RUN_ENV` on every call rather than caching it in a module constant: the registration gate
 * and the policy notices are exercised under both environments within one test process, and a
 * cached constant would freeze whichever value was present at import time. That coupling is what
 * keeps the wizard's Policies step, the plaintext notices, and `/legal` availability from
 * disagreeing about which environment they are in.
 */
export function isHostedPolicyEnvironment(): boolean {
  return process.env.RUN_ENV === "production";
}
