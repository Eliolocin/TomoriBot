/**
 * Regression harness: StatRepository (stat_counters) write/buffer + aggregation.
 *
 * Covers plan §11: buffered additive UPSERT, per-tuple collapsing, per-user grain,
 * persona-agnostic sentinel, token accumulation + cost read, shutdown drain, the
 * documented crash window, and the read/aggregation layer.
 *
 * Requires: a local Postgres connection (see docs/guides/testing-db-changes.md)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { statRepository, userRepository } from "@/utils/db/repositories";
import { FIXTURE_IDS, cleanupFixtures, insertFixtures, type FixtureRefs } from "./setup/fixtures";
import { DB_TESTS_AVAILABLE, setupTestDb, testSql } from "./setup/testDb";

const TEST_MODEL = "_rt_stat_model";
const REUNION_OTHER_SERVER_DISC_ID = "_rt_stat_reunion_other_server";

/** YYYY-MM-DD for `n` days before today (UTC): matches StatRepository's bucket grain. */
function dayOffset(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().split("T")[0];
}

describe.skipIf(!DB_TESTS_AVAILABLE)("StatRepository — regression", () => {
  let refs: FixtureRefs;
  let altUserId: number;
  let lineageA: number;
  let lineageB: number;

  beforeAll(async () => {
    await setupTestDb();
    refs = await insertFixtures(testSql);
    const altUser = await userRepository.register(FIXTURE_IDS.altUserDiscId, "_rt_alt_user", "en");
    if (!altUser) throw new Error("Failed to register alt test user");
    altUserId = altUser.user_id;
    lineageA = refs.personaLineageId;
    lineageB = refs.personaLineageId + 1000; // distinct lineage (no FK on persona_lineage_id)

    // Test model with known pricing for the cost-estimate read.
    await testSql`
      INSERT INTO llms (llm_provider, llm_codename, input_price_per_million, output_price_per_million)
      VALUES ('_rt_provider', ${TEST_MODEL}, 10, 20)
      ON CONFLICT (llm_provider, llm_codename) DO UPDATE
      SET input_price_per_million = 10, output_price_per_million = 20
    `;
  });

  afterAll(async () => {
    await statRepository.shutdown();
    await testSql`DELETE FROM llms WHERE llm_codename = ${TEST_MODEL}`;
    await testSql`DELETE FROM servers WHERE server_disc_id = ${REUNION_OTHER_SERVER_DISC_ID}`;
    await cleanupFixtures(testSql);
  });

  beforeEach(async () => {
    await statRepository.flush();
    await testSql`DELETE FROM stat_counters WHERE server_id = ${refs.serverId}`;
    await testSql`DELETE FROM conditioning_history WHERE server_id = ${refs.serverId}`;
    await testSql`DELETE FROM image_quotas WHERE server_id = ${refs.serverId}`;
    await testSql`DELETE FROM video_quotas WHERE server_id = ${refs.serverId}`;
    await testSql`DELETE FROM text_quotas WHERE server_id = ${refs.serverId}`;
    await testSql`DELETE FROM servers WHERE server_disc_id = ${REUNION_OTHER_SERVER_DISC_ID}`;
  });

  /** Reads a single counter row's count for the fixture server. */
  async function readCount(metric: string, metricKey: string, lineageId: number, userId: number): Promise<number> {
    const [row] = await testSql<{ count: number | string }[]>`
      SELECT count FROM stat_counters
      WHERE server_id = ${refs.serverId} AND user_id = ${userId}
        AND persona_lineage_id = ${lineageId} AND metric = ${metric} AND metric_key = ${metricKey}
    `;
    return row ? Number(row.count) : 0;
  }

  it("recordStat then flush produces one row with the delta", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    await statRepository.flush();
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(1);
  });

  it("repeated recordStat on the same tuple collapses to one UPSERT with summed count", async () => {
    for (let i = 0; i < 5; i++) {
      statRepository.recordStat({
        serverId: refs.serverId,
        userId: refs.userId,
        lineageId: lineageA,
        metric: "message_sent",
      });
    }
    expect(statRepository.bufferedEntryCount).toBe(1);
    await statRepository.flush();
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(5);
    expect(statRepository.bufferedEntryCount).toBe(0);
  });

  it("two different users on the same persona/metric/day produce two rows", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: altUserId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    await statRepository.flush();
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(1);
    expect(await readCount("message_sent", "", lineageA, altUserId)).toBe(1);
  });

  it("persona-agnostic metrics (command_used, panel_action) write the lineage-0 sentinel", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "command_used",
      metricKey: "config",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "panel_action",
      metricKey: "providers.workspace.provider.add",
    });
    await statRepository.flush();
    expect(await readCount("command_used", "config", 0, refs.userId)).toBe(1);
    expect(await readCount("command_used", "config", lineageA, refs.userId)).toBe(0);
    expect(await readCount("panel_action", "providers.workspace.provider.add", 0, refs.userId)).toBe(1);
    expect(await readCount("panel_action", "providers.workspace.provider.add", lineageA, refs.userId)).toBe(0);
  });

  it("user impersonation counters retain actor, target, and answering persona", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "user_impersonation_triggered",
      metricKey: FIXTURE_IDS.altUserDiscId,
    });
    await statRepository.flush();

    expect(await readCount("user_impersonation_triggered", FIXTURE_IDS.altUserDiscId, lineageA, refs.userId)).toBe(1);
    expect(await readCount("user_impersonation_triggered", FIXTURE_IDS.altUserDiscId, 0, refs.userId)).toBe(0);
  });

  it("tokens_in/tokens_out accumulate token deltas (not 1) and cost applies per-direction price exactly", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "tokens_in",
      metricKey: TEST_MODEL,
      delta: 1_000_000,
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "tokens_out",
      metricKey: TEST_MODEL,
      delta: 1_000_000,
    });
    await statRepository.flush();
    expect(await readCount("tokens_in", TEST_MODEL, lineageA, refs.userId)).toBe(1_000_000);
    expect(await readCount("tokens_out", TEST_MODEL, lineageA, refs.userId)).toBe(1_000_000);
    // Exact per-direction pricing (not averaged): input 10/M + output 20/M
    // → 1,000,000 input ($10) + 1,000,000 output ($20) = $30.
    const cost = await statRepository.getEstimatedCost({ serverId: refs.serverId });
    expect(cost).toBeCloseTo(30, 5);
  });

  it("shutdown drains the buffer", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    expect(statRepository.bufferedEntryCount).toBe(1);
    await statRepository.shutdown();
    expect(statRepository.bufferedEntryCount).toBe(0);
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(1);
  });

  it("shutdown waits for an active flush and drains entries buffered while it runs", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    const activeFlush = statRepository.flush();
    // Let flush() swap out its snapshot before recording the next entry.
    await Promise.resolve();

    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    await statRepository.shutdown();
    await activeFlush;

    expect(statRepository.bufferedEntryCount).toBe(0);
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(2);
  });

  it("crash window: unflushed deltas are not yet in the DB (documented tradeoff)", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "message_sent",
    });
    // No flush → buffered only; a hard crash here would lose exactly this delta.
    expect(statRepository.bufferedEntryCount).toBe(1);
    expect(await readCount("message_sent", "", lineageA, refs.userId)).toBe(0);
    await statRepository.flush(); // tidy up for the next test
  });

  it("recordStat skips when the server id is missing (NOT NULL FK guard)", () => {
    const before = statRepository.bufferedEntryCount;
    // @ts-expect-error intentionally passing an invalid serverId to assert the guard
    statRepository.recordStat({ serverId: undefined, userId: refs.userId, metric: "message_sent" });
    expect(statRepository.bufferedEntryCount).toBe(before);
  });

  it("getUserPersonaReunionInfo reads prior activity and today's delivery state across servers", async () => {
    const previousAt = new Date(`${dayOffset(4)}T18:30:00Z`);
    const [otherServer] = await testSql<{ server_id: number }[]>`
      INSERT INTO servers (server_disc_id)
      VALUES (${REUNION_OTHER_SERVER_DISC_ID})
      RETURNING server_id
    `;
    await testSql`
      INSERT INTO stat_counters
        (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count, first_at, last_at)
      VALUES
        (${otherServer.server_id}, ${refs.userId}, ${lineageA}, 'presence_seen', '', ${dayOffset(4)}::date, 2,
         ${previousAt}, ${previousAt}),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'presence_seen', '', ${dayOffset(0)}::date, 3,
         NOW(), NOW())
    `;

    const reunion = await statRepository.getUserPersonaReunionInfo(refs.userId, lineageA);
    expect(reunion?.lastPreviousDayAt?.toISOString()).toBe(previousAt.toISOString());
    expect(reunion?.seenToday).toBe(true);
  });

  it("getUserPersonaReunionInfo keeps legacy history but only presence consumes today's reunion", async () => {
    const legacyAt = new Date(`${dayOffset(9)}T08:00:00Z`);
    const presenceAt = new Date(`${dayOffset(2)}T08:00:00Z`);
    await testSql`
      INSERT INTO stat_counters
        (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count, first_at, last_at)
      VALUES
        -- Relationship that predates the presence metric: the gap must still resolve.
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(9)}::date, 5,
         ${legacyAt}, ${legacyAt}),
        -- Today's message_sent must not consume the one-shot reunion.
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(0)}::date, 4,
         NOW(), NOW()),
        (${refs.serverId}, ${altUserId}, ${lineageA}, 'presence_seen', '', ${dayOffset(2)}::date, 1,
         ${presenceAt}, ${presenceAt})
    `;

    const reunion = await statRepository.getUserPersonaReunionInfo(refs.userId, lineageA);
    expect(reunion?.lastPreviousDayAt?.toISOString()).toBe(legacyAt.toISOString());
    expect(reunion?.seenToday).toBe(false);

    const alternate = await statRepository.getUserPersonaReunionInfo(altUserId, lineageA);
    expect(alternate?.lastPreviousDayAt?.toISOString()).toBe(presenceAt.toISOString());

    const empty = await statRepository.getUserPersonaReunionInfo(refs.userId, lineageB);
    expect(empty).toEqual({ lastPreviousDayAt: null, seenToday: false });
  });

  it("recordPresenceSeen persists immediately without entering the telemetry buffer", async () => {
    const before = statRepository.bufferedEntryCount;
    expect(
      await statRepository.recordPresenceSeen({
        serverId: refs.serverId,
        userId: refs.userId,
        lineageId: lineageA,
      }),
    ).toBe(true);

    expect(statRepository.bufferedEntryCount).toBe(before);
    expect(await readCount("presence_seen", "", lineageA, refs.userId)).toBe(1);
    expect((await statRepository.getUserPersonaReunionInfo(refs.userId, lineageA))?.seenToday).toBe(true);
  });

  it("getFavoritePersona ranks by message share and computes loyalty %", async () => {
    for (let i = 0; i < 3; i++) {
      statRepository.recordStat({
        serverId: refs.serverId,
        userId: refs.userId,
        lineageId: lineageA,
        metric: "message_sent",
      });
    }
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageB,
      metric: "message_sent",
    });
    await statRepository.flush();

    const fav = await statRepository.getFavoritePersona({ userId: refs.userId, serverId: refs.serverId });
    expect(fav?.lineageId).toBe(lineageA);
    expect(fav?.count).toBe(3);
    expect(fav?.totalCount).toBe(4);
    expect(fav?.loyaltyPct).toBeCloseTo(75, 5);
  });

  it("getTopCommands orders by count and getUnusedCommands comes from the registry minus rows", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      metric: "command_used",
      metricKey: "config",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      metric: "command_used",
      metricKey: "config",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      metric: "command_used",
      metricKey: "memory",
    });
    await statRepository.flush();

    const top = await statRepository.getTopCommands({ serverId: refs.serverId, limit: 10 });
    expect(top[0]).toEqual({ command: "config", count: 2 });
    expect(top[1]).toEqual({ command: "memory", count: 1 });

    // "persona" never ran → must surface from the registry list, not the table.
    const unused = await statRepository.getUnusedCommands(["config", "memory", "persona"], { serverId: refs.serverId });
    expect(unused).toEqual(["persona"]);
  });

  it("getModelBreakdown aggregates model_used by metric_key", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "model_used",
      metricKey: TEST_MODEL,
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "model_used",
      metricKey: TEST_MODEL,
    });
    await statRepository.flush();
    const breakdown = await statRepository.getModelBreakdown({ serverId: refs.serverId });
    expect(breakdown.find((m) => m.model === TEST_MODEL)?.count).toBe(2);
  });

  it("getEmotionBreakdown surfaces non-identity sprite tags as emotions, lower-cased and collapsed, while identity sprites stay out", async () => {
    // sprite_shown counts every delivered sprite (identity "yuki" + non-identity "happy"/"Happy");
    // sprite_emotion is recorded only for non-identity sprites, so the emotion read sees just "happy".
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "sprite_shown",
      metricKey: "happy",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "sprite_shown",
      metricKey: "yuki", // identity sprite: present in the leaderboard, absent from emotions
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "sprite_emotion",
      metricKey: "happy",
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "sprite_emotion",
      metricKey: "Happy",
    });
    await statRepository.flush();

    const emotions = await statRepository.getEmotionBreakdown({ serverId: refs.serverId });
    expect(emotions.find((e) => e.emotion === "happy")?.count).toBe(2);
    // The identity sprite never produced a sprite_emotion row, so it is not an emotion.
    expect(emotions.find((e) => e.emotion === "yuki")).toBeUndefined();

    const sprites = await statRepository.getMetricKeyBreakdown({ metric: "sprite_shown", serverId: refs.serverId });
    expect(sprites.find((s) => s.key === "happy")?.count).toBe(1);
    expect(sprites.find((s) => s.key === "yuki")?.count).toBe(1);
  });

  it("windowed reads (bucket >= from) sum only in-window rows", async () => {
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(0)}::date, 5),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(10)}::date, 7)
    `;
    const allTime = await statRepository.getPersonaAffinity({ userId: refs.userId, serverId: refs.serverId });
    expect(allTime.find((a) => a.lineageId === lineageA)?.count).toBe(12);

    const last3Days = await statRepository.getPersonaAffinity({
      userId: refs.userId,
      serverId: refs.serverId,
      from: dayOffset(3),
    });
    expect(last3Days.find((a) => a.lineageId === lineageA)?.count).toBe(5);
  });

  it("getActivityHistogram buckets by hour-of-day and weekday", async () => {
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '14', ${dayOffset(0)}::date, 3),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '14', ${dayOffset(1)}::date, 2),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '9',  ${dayOffset(0)}::date, 1)
    `;
    const hist = await statRepository.getActivityHistogram({ userId: refs.userId });
    expect(hist.byHour[14]).toBe(5);
    expect(hist.byHour[9]).toBe(1);
    // Weekday totals sum the same rows; total across weekdays must equal 6.
    const weekdayTotal = Object.values(hist.byWeekday).reduce((a, b) => a + b, 0);
    expect(weekdayTotal).toBe(6);
  });

  it("getActivityHeatmap returns the correct 2-D joint weekday×hour grid", async () => {
    // Fixed calendar dates with known weekdays (EXTRACT(DOW): 0=Sun..6=Sat):
    //   2024-01-01 = Monday (dow 1), 2024-01-08 = Monday (dow 1), 2024-01-02 = Tuesday (dow 2).
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '14', '2024-01-01'::date, 3),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '14', '2024-01-08'::date, 2),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '9',  '2024-01-02'::date, 1)
    `;
    const grid = await statRepository.getActivityHeatmap({ userId: refs.userId });
    expect(grid[1][14]).toBe(5);
    expect(grid[2][9]).toBe(1);
    expect(grid[0][0]).toBe(0);
    expect(grid[6][23]).toBe(0);
    const total = Object.values(grid).reduce((sum, row) => sum + Object.values(row).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(6);
  });

  it("getActivityHeatmap timezone offset crossing midnight rolls into the previous weekday's cell", async () => {
    // Seed Tuesday (2024-01-02 = dow 2) at 01:00 UTC. With a UTC-2 personal offset
    // the local time is 23:00 MONDAY, so the hour roll must move the weekday too.
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '1', '2024-01-02'::date, 4)
    `;
    const grid = await statRepository.getActivityHeatmap({ userId: refs.userId, offsetHours: -2 });
    // wh = 2*24 + 1 = 49; (49 - 2) mod 168 = 47 → dow 1 (Mon), hour 23.
    expect(grid[1][23]).toBe(4);
    // The original server-wall-clock cell (Tue 01:00) is now empty.
    expect(grid[2][1]).toBe(0);
  });

  it("getActivityHeatmap timezone offset wraps across the week boundary", async () => {
    // Sunday (2024-01-07 = dow 0) at 00:00 UTC with a UTC-1 offset is 23:00 SATURDAY
    // of the prior week, so the week-hour index must wrap mod 168 (0 → 167).
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'active_hour', '0', '2024-01-07'::date, 7)
    `;
    const grid = await statRepository.getActivityHeatmap({ userId: refs.userId, offsetHours: -1 });
    // wh = 0; (0 - 1 + 168) mod 168 = 167 → dow 6 (Sat), hour 23.
    expect(grid[6][23]).toBe(7);
    expect(grid[0][0]).toBe(0);
  });

  it("getStreak derives current/longest from distinct active bucket dates", async () => {
    await testSql`
      INSERT INTO stat_counters (server_id, user_id, persona_lineage_id, metric, metric_key, bucket, count)
      VALUES
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(0)}::date, 1),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(1)}::date, 1),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(2)}::date, 1),
        (${refs.serverId}, ${refs.userId}, ${lineageA}, 'message_sent', '', ${dayOffset(10)}::date, 1)
    `;
    const streak = await statRepository.getStreak({ userId: refs.userId });
    expect(streak.currentStreak).toBe(3);
    expect(streak.longestStreak).toBe(3);
    expect(streak.lastActiveDate).toBe(dayOffset(0));
  });

  it("getGenerationTotals reads canonical stat_counters telemetry with user scope", async () => {
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "text_generated",
      delta: 7,
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "image_generated",
      delta: 4,
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: refs.userId,
      lineageId: lineageA,
      metric: "video_generated",
      delta: 2,
    });
    statRepository.recordStat({
      serverId: refs.serverId,
      userId: altUserId,
      lineageId: lineageB,
      metric: "image_generated",
      delta: 3,
    });
    await statRepository.flush();

    const totals = await statRepository.getGenerationTotals({ serverId: refs.serverId });
    expect(totals.imageGenerations).toBe(7);
    expect(totals.videoGenerations).toBe(2);
    expect(totals.textGenerations).toBe(7);

    const userTotals = await statRepository.getGenerationTotals({ serverId: refs.serverId, userId: refs.userId });
    expect(userTotals.imageGenerations).toBe(4);
    expect(userTotals.videoGenerations).toBe(2);
    expect(userTotals.textGenerations).toBe(7);
  });

  it("getConditioningTotals matches conditioning_history reward/punish counts", async () => {
    await testSql`
      INSERT INTO conditioning_history
        (server_id, persona_lineage_id, conditioning_type, action_key, reason_text, reason_normalized, user_id, count)
      VALUES
        (${refs.serverId}, ${lineageA}, 'reward', '_rt_a', 'r', 'r', ${refs.userId}, 3),
        (${refs.serverId}, ${lineageA}, 'punish', '_rt_b', 'p', 'p', ${refs.userId}, 1)
    `;
    const totals = await statRepository.getConditioningTotals({ serverId: refs.serverId });
    expect(totals.rewards).toBe(3);
    expect(totals.punishments).toBe(1);
  });
});
