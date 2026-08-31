#!/usr/bin/env bun
import { config } from "dotenv";
import pc from "picocolors";
import { confirm, isNonInteractiveMode } from "../lib/prompt";
import { log } from "../lib/cliLogger";

config({ quiet: true });

interface RunOptions {
  allowFailure?: boolean;
}

const ROOT = process.cwd();

function printHelp(): void {
  console.log(`
${pc.bold("bun run update")} - backup-first TomoriBot updater

${pc.bold("Usage:")}
  bun run update                  Backup, git pull, bun install --frozen-lockfile
  bun run update --build          Also run bun run build after install
  bun run update --docker         Backup, git pull, docker compose build, docker compose up -d
  bun run update --skip-backup    Skip the pre-update backup step
  bun run update --yes            Do not prompt before starting

${pc.bold("Notes:")}
  Stop TomoriBot before updating so the backup and migrations have a quiet database.
  This command uses: git pull --rebase --autostash
  A pulled update may require a newer Bun. Run bun upgrade if this command asks for one.
  If Git reports "needs merge", resolve the listed files, run git add on them, then re-run update.
`);
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<boolean> {
  const proc = Bun.spawn([command, ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    return true;
  }

  const rendered = `${command} ${args.join(" ")}`;
  if (options.allowFailure) {
    log.warn(`${rendered} exited with code ${exitCode}.`);
    return false;
  }
  throw new Error(`${rendered} exited with code ${exitCode}.`);
}

async function ensureGitRepository(): Promise<void> {
  const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0 || stdout.trim() !== "true") {
    throw new Error("This directory is not a Git worktree.");
  }
}

async function getUnmergedPaths(): Promise<string[]> {
  const proc = Bun.spawn(["git", "diff", "--name-only", "--diff-filter=U"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  if (exitCode !== 0) {
    return [];
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Compares two dot-separated version strings numerically.
 *
 * @returns Negative when `a` precedes `b`, zero when equal, positive otherwise.
 */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * Aborts the update when the running Bun is older than the `packageManager` pin.
 *
 * Bun refuses to parse a lockfile written by a newer major or minor, so an outdated runtime fails
 * the install with `UnknownLockfileVersion` naming only `bun.lock`. That reads as a corrupt
 * repository rather than an outdated runtime, and the natural recovery (dropping
 * `--frozen-lockfile`) makes Bun ignore the lockfile and re-resolve every dependency from its
 * version ranges, silently drifting off the tested tree. Failing here keeps that door shut.
 *
 * Must run after the pull: `packageManager` is read from the checkout, so before the pull it still
 * carries the previous requirement.
 */
async function ensureBunRuntimeVersion(): Promise<void> {
  const packageJson = (await Bun.file("package.json").json()) as { packageManager?: string };
  const pin = packageJson.packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];
  if (!pin || compareVersions(Bun.version, pin) >= 0) {
    return;
  }

  log.error(`TomoriBot needs Bun ${pin} or newer, but this is Bun ${Bun.version}.`);
  log.info("Upgrade the Bun runtime, then re-run the update:");
  log.info("  bun upgrade");
  log.info("  bun run update");
  log.info("The code is already up to date, so TomoriBot still starts on your current Bun.");
  log.warn("Do not run a plain `bun install` to bypass this. Without --frozen-lockfile Bun ignores");
  log.warn("the lockfile and re-resolves every dependency, which drifts you off the tested versions.");
  process.exit(1);
}

function printGitConflictGuidance(paths: string[]): void {
  log.warn("Git has unresolved merge conflicts.");
  if (paths.length > 0) {
    log.info("Conflicted files:");
    for (const path of paths) {
      log.info(`  ${path}`);
    }
  }
  log.info("Open each conflicted file, choose the correct content, and remove conflict markers:");
  log.info("  <<<<<<<");
  log.info("  =======");
  log.info("  >>>>>>>");
  log.info("Then mark the files resolved:");
  log.info("  git add <resolved-file> [...]");
  log.info("If Git says a stash entry was kept, leave it alone until you have confirmed your changes are present.");
  log.info("After the worktree is clean of conflicts, re-run `bun run update`.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args);

  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }

  const skipBackup = flags.has("--skip-backup");
  const build = flags.has("--build");
  const docker = flags.has("--docker");

  log.section("TomoriBot Update");
  log.info("Stop the running bot before continuing. This avoids writes during backup/update.");
  log.info("Update command: git pull --rebase --autostash");

  if (!isNonInteractiveMode() && !(await confirm("Continue with update?", true))) {
    log.info("Update cancelled.");
    return;
  }

  await ensureGitRepository();
  const existingConflicts = await getUnmergedPaths();
  if (existingConflicts.length > 0) {
    printGitConflictGuidance(existingConflicts);
    process.exit(1);
  }

  if (skipBackup) {
    log.warn("Skipping backup because --skip-backup was provided.");
  } else {
    log.section("Backup");
    try {
      await run("bun", ["run", "backup"]);
    } catch (error) {
      log.error("Backup failed. Update aborted before changing code.", error);
      log.info("Fix the backup issue, or re-run with --skip-backup if you accept the risk.");
      process.exit(1);
    }
  }

  log.section("Pull latest code");
  try {
    await run("git", ["pull", "--rebase", "--autostash"]);
  } catch (error) {
    log.error("Git pull failed. Update stopped before dependency install.", error);
    const conflictedPaths = await getUnmergedPaths();
    if (conflictedPaths.length > 0) {
      printGitConflictGuidance(conflictedPaths);
    } else {
      log.info("No unresolved merge files were reported. Review the Git output above, fix the issue, then re-run update.");
    }
    process.exit(1);
  }

  if (docker) {
    log.section("Docker Compose update");
    await run("docker", ["compose", "build"]);
    await run("docker", ["compose", "up", "-d"]);
  } else {
    await ensureBunRuntimeVersion();

    log.section("Install dependencies");
    await run("bun", ["install", "--frozen-lockfile"]);

    if (build) {
      log.section("Build");
      await run("bun", ["run", "build"]);
    }
  }

  log.section("Update Complete");
  if (docker) {
    log.info("Docker Compose is running with the updated image.");
  } else {
    log.info("Restart TomoriBot with `bun run dev`, `bun run launch`, or your process manager.");
  }
}

main().catch((error) => {
  log.error("Update failed:", error);
  process.exit(1);
});
