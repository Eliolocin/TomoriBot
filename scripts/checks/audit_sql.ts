/**
 * Raw-SQL boundary audit (CLI).
 *
 * Reports every raw `sql`/`tx` template literal found outside the repository
 * layer and EXITS NON-ZERO when any genuine violation exists, so the
 * `bun run vl` "SQL Audit" gate enforces the standard (it previously only
 * printed and always passed). The actual scan lives in
 * `scripts/checks/lib/sqlAudit.ts`: shared with the unit test so the two can
 * never disagree.
 *
 * Run via `bun run audit-sql`.
 */

import { auditRawSqlBoundary, normalizePath } from "./lib/sqlAudit";

async function run() {
  const { violations, exemptions } = await auditRawSqlBoundary();

  const writes = violations.filter((v) => v.kind === "WRITE");
  const reads = violations.filter((v) => v.kind === "READ");

  // Listings are proportional to findings: empty sections print nothing, and the
  // exemption list is detail a reader only needs when deciding whether a violation is
  // already covered, so a clean run reports its counts and stops.
  if (writes.length > 0) {
    console.log("=== WRITES ===");
    writes.forEach((w) => console.log(`${normalizePath(w.file)}:${w.line}`));
  }
  if (reads.length > 0) {
    console.log("=== READS ===");
    reads.forEach((r) => console.log(`${normalizePath(r.file)}:${r.line}`));
  }

  if (violations.length > 0) {
    console.log("=== EXEMPTIONS ===");
    exemptions.forEach((e) => console.log(`exempt: ${normalizePath(e.file)}:${e.line} (${e.kind}; ${e.reason})`));
    console.error(
      `\n❌ Found ${violations.length} raw SQL ${violations.length === 1 ? "query" : "queries"} outside ` +
        "src/utils/db/repositories/. Move them into a repository method, or add a justified exemption " +
        "in scripts/checks/lib/sqlAudit.ts (EXEMPT_PATHS).",
    );
    process.exit(1);
  }

  console.log(
    "✅ No raw SQL outside the repository layer " +
      `(${writes.length} writes, ${reads.length} reads, ${exemptions.length} exemptions).`,
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
