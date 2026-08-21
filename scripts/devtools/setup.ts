#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { config } from "dotenv";
import { isPlaceholder, readEnvValues, seedFromExample, upsertEnvKeys } from "../lib/envFile";
import { ask, askSecret, confirm, isNonInteractiveMode, type MenuItem, selectMenu } from "../lib/prompt";
import { type SetupContext, type SetupModule, getFullInstallModules } from "../setup/registry";
import { log } from "../lib/cliLogger";

config({ quiet: true });

interface CommandProbe {
  available: boolean;
  output?: string;
}

interface PrereqScan {
  hasPsql: boolean;
  hasPgDump: boolean;
  hasDocker: boolean;
}

interface DatabaseConfigResult {
  values: Record<string, string>;
  startDockerDatabase: boolean;
}

interface PostgresConnection {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

type EnvConfigureMode = "fill" | "reconfigure" | "keep";
type SetupMode = "base" | "full";

interface BaseInstallOptions {
  showCompletion?: boolean;
}

const ROOT = process.cwd();
const ENV_PATH = join(ROOT, ".env");
const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");
const REQUIRED_ENV_KEYS = [
  "DISCORD_TOKEN",
  "CRYPTO_SECRET",
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
];
function printHelp(): void {
  console.log(`
${pc.bold("bun run setup")} - interactive TomoriBot setup wizard

${pc.bold("Usage:")}
  bun run setup              Choose Full Install (recommended) or Base Install
  bun run setup --base       Run Base Install only
  bun run setup --full       Run Base Install, then optional DB/AI helper setup
  bun run setup --defaults   Accept safe defaults for Base Install
  bun run setup --full --defaults
                             Accept safe defaults for Full Install

${pc.bold("Examples:")}
  bun run setup
  bun run setup --base
  bun run setup --full
  bun run setup --full --defaults
  bun run setup --defaults
`);
}

async function commandProbe(command: string, args: string[]): Promise<CommandProbe> {
  try {
    const proc = Bun.spawn([command, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}${stderr}`.trim();
    return {
      available: exitCode === 0,
      output,
    };
  } catch {
    return { available: false };
  }
}

async function runInherited(command: string, args: string[]): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${exitCode}`);
  }
}

function parseNodeMajor(output: string | undefined): number | undefined {
  const match = output?.match(/v?(\d+)\./);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10);
}

async function scanPrereqs(): Promise<PrereqScan> {
  log.section("Prerequisite scan");

  const [nodeProbe, psqlProbe, pgDumpProbe, dockerProbe] = await Promise.all([
    commandProbe("node", ["--version"]),
    commandProbe("psql", ["--version"]),
    commandProbe("pg_dump", ["--version"]),
    commandProbe("docker", ["--version"]),
  ]);

  const nodeMajor = parseNodeMajor(nodeProbe.output);
  if (nodeProbe.available && nodeMajor && nodeMajor >= 20) {
    log.success(`Node.js ${nodeProbe.output ?? ""}`.trim());
  } else if (nodeProbe.available) {
    log.warn(`Node.js ${nodeProbe.output ?? ""} detected, but v20+ is recommended for MCP tooling.`);
  } else {
    log.warn("Node.js was not found. Install Node.js v20+ for MCP tooling.");
  }

  if (psqlProbe.available) {
    log.success(`psql ${psqlProbe.output ?? ""}`.trim());
  } else {
    log.warn("psql was not found. Native database auto-provisioning needs PostgreSQL client tools.");
  }

  if (pgDumpProbe.available) {
    log.success(`pg_dump ${pgDumpProbe.output ?? ""}`.trim());
  } else {
    log.warn("pg_dump was not found. Backups and backup-first updates need PostgreSQL client tools.");
  }

  if (dockerProbe.available) {
    log.success(`Docker ${dockerProbe.output ?? ""}`.trim());
  } else {
    log.warn("Docker was not found. Docker database setup will be unavailable.");
  }

  return {
    hasPsql: psqlProbe.available,
    hasPgDump: pgDumpProbe.available,
    hasDocker: dockerProbe.available,
  };
}

function buildContext(scan: PrereqScan): SetupContext {
  return {
    projectRoot: ROOT,
    envPath: ENV_PATH,
    hasPsql: scan.hasPsql,
  };
}

function generateSecret(length = 32): string {
  return randomBytes(Math.ceil((length * 3) / 4)).toString("base64url").slice(0, length);
}

function validateNonPlaceholder(label: string): (value: string) => string | null {
  return (value) => {
    if (isPlaceholder(value)) {
      return `${label} cannot be blank or left as a placeholder.`;
    }
    return null;
  };
}

function getMissingRequiredEnvKeys(env: Record<string, string>): string[] {
  return REQUIRED_ENV_KEYS.filter((key) => isPlaceholder(env[key]));
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildPostgresUrl(connection: PostgresConnection): string {
  const user = encodeURIComponent(connection.user);
  const auth =
    connection.password.trim().length > 0 ? `${user}:${encodeURIComponent(connection.password)}` : user;
  return `postgresql://${auth}@${connection.host}:${connection.port}/${connection.database}`;
}

function buildProvisioningSql(appUser: string, appPassword: string, appDatabase: string): {
  roleSql: string;
  databaseExistsSql: string;
  createDatabaseSql: string;
} {
  return {
    roleSql: [
      "DO $tomori_setup$",
      "BEGIN",
      `  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${quoteSqlLiteral(appUser)}) THEN`,
      `    CREATE ROLE ${quoteSqlIdentifier(appUser)} WITH LOGIN SUPERUSER PASSWORD ${quoteSqlLiteral(appPassword)};`,
      "  ELSE",
      `    ALTER ROLE ${quoteSqlIdentifier(appUser)} WITH LOGIN SUPERUSER PASSWORD ${quoteSqlLiteral(appPassword)};`,
      "  END IF;",
      "END",
      "$tomori_setup$;",
    ].join("\n"),
    databaseExistsSql: `SELECT 1 FROM pg_database WHERE datname = ${quoteSqlLiteral(appDatabase)};`,
    createDatabaseSql: `CREATE DATABASE ${quoteSqlIdentifier(appDatabase)} OWNER ${quoteSqlIdentifier(appUser)};`,
  };
}

function printManualProvisioningSql(sql: ReturnType<typeof buildProvisioningSql>): void {
  log.info("Run this SQL as a local PostgreSQL admin:");
  log.info(sql.roleSql);
  log.info(sql.createDatabaseSql);
  log.warn("TomoriBot cannot connect with these .env database credentials until this SQL has run successfully.");
}

async function runPsql(connection: PostgresConnection, sql: string, stdout: "inherit" | "pipe" = "inherit"): Promise<{
  exitCode: number;
  output: string;
}> {
  const outputArgs = stdout === "pipe" ? ["-t", "-A"] : [];
  const proc = Bun.spawn(
    ["psql", buildPostgresUrl(connection), "-v", "ON_ERROR_STOP=1", ...outputArgs, "-c", sql],
    {
      cwd: ROOT,
      stdout,
      stderr: "inherit",
    },
  );
  const exitCode = await proc.exited;
  const output = stdout === "pipe" ? await new Response(proc.stdout).text() : "";
  return { exitCode, output };
}

async function provisionNativeDatabase(app: PostgresConnection, hasPsql: boolean): Promise<void> {
  const sql = buildProvisioningSql(app.user, app.password, app.database);

  if (!hasPsql) {
    log.warn("psql is missing, so automatic database provisioning is not available.");
    printManualProvisioningSql(sql);
    return;
  }

  const shouldProvision = await confirm(
    "Create/update the local PostgreSQL app user as SUPERUSER and create the database automatically?",
    true,
  );
  if (!shouldProvision) {
    printManualProvisioningSql(sql);
    return;
  }

  log.info("This is intended for local/dev self-hosting. Do not use a superuser app role on shared production DBs.");
  const adminUser = await ask("PostgreSQL admin user", {
    default: "postgres",
    validate: validateNonPlaceholder("Admin user"),
  });
  const adminPassword = await askSecret("PostgreSQL admin password", {
    validate: validateNonPlaceholder("Admin password"),
  });
  const maintenanceDb = await ask("Maintenance database", {
    default: "postgres",
    validate: validateNonPlaceholder("Maintenance database"),
  });

  const adminConnection: PostgresConnection = {
    host: app.host,
    port: app.port,
    user: adminUser,
    password: adminPassword,
    database: maintenanceDb,
  };

  const roleResult = await runPsql(adminConnection, sql.roleSql);
  if (roleResult.exitCode !== 0) {
    log.warn("Could not create/update the PostgreSQL user automatically.");
    printManualProvisioningSql(sql);
    return;
  }

  const existsResult = await runPsql(adminConnection, sql.databaseExistsSql, "pipe");
  if (existsResult.exitCode !== 0) {
    log.warn("Could not check whether the database already exists.");
    log.info("Run this SQL as a local PostgreSQL admin if needed:");
    log.info(sql.createDatabaseSql);
    log.warn("TomoriBot cannot connect with these .env database credentials until the database exists.");
    return;
  }

  if (existsResult.output.trim() === "1") {
    log.success(`Database "${app.database}" already exists.`);
    return;
  }

  const dbResult = await runPsql(adminConnection, sql.createDatabaseSql);
  if (dbResult.exitCode === 0) {
    log.success(`Database "${app.database}" created.`);
    return;
  }

  log.warn("Could not create the database automatically.");
  log.info("Run this SQL as a local PostgreSQL admin:");
  log.info(sql.createDatabaseSql);
  log.warn("TomoriBot cannot connect with these .env database credentials until the database exists.");
}

async function chooseEnvMode(envAlreadyExisted: boolean, env: Record<string, string>): Promise<EnvConfigureMode> {
  if (!envAlreadyExisted) {
    return "fill";
  }

  const missingRequiredKeys = getMissingRequiredEnvKeys(env);
  const canUseCurrentEnv = missingRequiredKeys.length === 0;
  const selected = await selectMenu<EnvConfigureMode>("Existing .env found", [
    {
      id: "fill",
      label: "(Recommended) Fill missing required values",
      description: "Keep real values and replace blanks/placeholders.",
    },
    {
      id: "reconfigure",
      label: "Reconfigure required values",
      description: "Prompt for Discord token and database settings again.",
    },
    {
      id: "keep",
      label: "Use current .env without changes",
      description: canUseCurrentEnv
        ? "Skip prompts because all required values are already set."
        : `Unavailable until these required values are set: ${missingRequiredKeys.join(", ")}.`,
      disabled: !canUseCurrentEnv,
    },
  ]);

  return selected.id;
}

async function configureDiscordToken(env: Record<string, string>, mode: EnvConfigureMode): Promise<Record<string, string>> {
  if (mode === "keep" || (mode === "fill" && !isPlaceholder(env.DISCORD_TOKEN))) {
    return {};
  }

  log.info("Create/copy your bot token from https://discord.com/developers/applications");
  log.info("Enable these Privileged Gateway Intents for the bot: GuildMembers, MessageContent, GuildPresences.");
  const token = await askSecret("Discord bot token", {
    default: isPlaceholder(env.DISCORD_TOKEN) ? undefined : env.DISCORD_TOKEN,
    validate: (value) => {
      if (isPlaceholder(value)) return "Discord token cannot be blank or left as a placeholder.";
      if (value.trim().length < 30) return "Discord token looks too short.";
      return null;
    },
  });

  return { DISCORD_TOKEN: token.trim() };
}

async function configureCryptoSecret(env: Record<string, string>, mode: EnvConfigureMode): Promise<Record<string, string>> {
  if (isPlaceholder(env.CRYPTO_SECRET)) {
    const secret = generateSecret();
    log.success("Generated a 32-character CRYPTO_SECRET.");
    return { CRYPTO_SECRET: secret };
  }

  if (mode !== "reconfigure") {
    return {};
  }

  const rotate = await confirm(
    "Generate a new CRYPTO_SECRET? Existing encrypted API keys need the old secret to decrypt.",
    false,
  );
  if (!rotate) {
    log.info("Keeping existing CRYPTO_SECRET.");
    return {};
  }

  const secret = generateSecret();
  log.success("Generated a new 32-character CRYPTO_SECRET.");
  return { CRYPTO_SECRET: secret };
}

function needsDatabaseConfig(env: Record<string, string>, mode: EnvConfigureMode): boolean {
  if (mode === "keep") return false;
  if (mode === "reconfigure") return true;
  return getMissingRequiredEnvKeys(env).some((key) => key.startsWith("POSTGRES_"));
}

async function configureNativeDatabase(env: Record<string, string>, scan: PrereqScan): Promise<DatabaseConfigResult> {
  log.info("These values define the TomoriBot database account to create/use.");
  log.info("For a new local setup on this machine, the defaults are usually fine.");

  const host = await ask("PostgreSQL host", {
    default: isPlaceholder(env.POSTGRES_HOST) ? "localhost" : env.POSTGRES_HOST,
    validate: validateNonPlaceholder("PostgreSQL host"),
  });
  const port = await ask("PostgreSQL port", {
    default: isPlaceholder(env.POSTGRES_PORT) ? "5432" : env.POSTGRES_PORT,
    validate: (value) => (/^\d+$/.test(value.trim()) ? null : "Port must be a number."),
  });
  const user = await ask("TomoriBot database user", {
    default: isPlaceholder(env.POSTGRES_USER) ? "tomori" : env.POSTGRES_USER,
    validate: validateNonPlaceholder("Database user"),
  });
  const password = await askSecret("TomoriBot database password", {
    default: isPlaceholder(env.POSTGRES_PASSWORD) ? generateSecret(24) : env.POSTGRES_PASSWORD,
    validate: validateNonPlaceholder("Database password"),
  });
  const database = await ask("TomoriBot database name", {
    default: isPlaceholder(env.POSTGRES_DB) ? "tomodb" : env.POSTGRES_DB,
    validate: validateNonPlaceholder("Database name"),
  });

  await provisionNativeDatabase(
    {
      host,
      port,
      user,
      password,
      database,
    },
    scan.hasPsql,
  );

  return {
    values: {
      POSTGRES_HOST: host,
      POSTGRES_PORT: port,
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    },
    startDockerDatabase: false,
  };
}

async function configureDockerDatabase(env: Record<string, string>): Promise<DatabaseConfigResult> {
  const password = await askSecret("PostgreSQL password for the local Docker database", {
    default: isPlaceholder(env.POSTGRES_PASSWORD) ? generateSecret(24) : env.POSTGRES_PASSWORD,
    validate: validateNonPlaceholder("Docker PostgreSQL password"),
  });

  return {
    values: {
      POSTGRES_HOST: "localhost",
      POSTGRES_PORT: "15432",
      POSTGRES_USER: "tomori",
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: "tomodb",
    },
    startDockerDatabase: true,
  };
}

async function configureDatabase(env: Record<string, string>, mode: EnvConfigureMode, scan: PrereqScan): Promise<DatabaseConfigResult> {
  if (!needsDatabaseConfig(env, mode)) {
    return { values: {}, startDockerDatabase: false };
  }

  const dockerChoice: MenuItem<"native" | "docker"> = {
    id: "docker",
    label: "Use bundled Docker PostgreSQL",
    description: scan.hasDocker
      ? "Database-only container on localhost:15432; TomoriBot and scripts still run on host Bun."
      : "Unavailable because Docker was not detected.",
    disabled: !scan.hasDocker,
  };
  const nativeChoice: MenuItem<"native" | "docker"> = {
    id: "native",
    label: scan.hasPsql ? "(Recommended) Use installed PostgreSQL" : "Use an existing PostgreSQL server",
    description: scan.hasPsql
      ? "Best fit for local Bun when PostgreSQL is already installed; defaults usually work."
      : "Use this if you already know the host, port, user, database, and manual SQL steps.",
  };
  const choices: MenuItem<"native" | "docker">[] = scan.hasPsql
    ? [nativeChoice, dockerChoice]
    : scan.hasDocker
      ? [
          {
            ...dockerChoice,
            label: "(Recommended) Use bundled Docker PostgreSQL",
          },
          nativeChoice,
        ]
      : [nativeChoice, dockerChoice];

  const selected = await selectMenu<"native" | "docker">("Database for local Bun setup", choices);

  if (selected.id === "docker") {
    log.info("This uses Docker only for PostgreSQL. TomoriBot will still start with `bun run dev` or `bun run launch`.");
    return configureDockerDatabase(env);
  }

  return configureNativeDatabase(env, scan);
}

async function maybeStartDockerDatabase(scan: PrereqScan): Promise<void> {
  if (!scan.hasDocker) {
    return;
  }
  if (!(await confirm("Start the Docker Compose PostgreSQL database now?", true))) {
    log.info("Start it later with: docker compose up -d postgres");
    return;
  }
  await runInherited("docker", ["compose", "up", "-d", "postgres"]);
}

async function runBunInstall(): Promise<void> {
  if (!(await confirm("Run bun install --frozen-lockfile now?", true))) {
    log.info("Skipped dependency install. Run `bun install --frozen-lockfile` before starting TomoriBot.");
    return;
  }
  await runInherited("bun", ["install", "--frozen-lockfile"]);
}

function printSetupComplete(title: string): void {
  log.section(title);
  log.info("Next steps:");
  log.info("  1. Start TomoriBot with `bun run dev` or `bun run launch`.");
  log.info("  2. When Discord shows the bot online, run `/setup` in your server.");
}

async function runBaseInstall(scan: PrereqScan, options: BaseInstallOptions = {}): Promise<void> {
  log.section("Base Install");

  const envAlreadyExisted = existsSync(ENV_PATH);
  if (seedFromExample(ENV_EXAMPLE_PATH, ENV_PATH)) {
    log.success("Created .env from .env.example.");
  }

  const env = readEnvValues(ENV_PATH);
  const mode = await chooseEnvMode(envAlreadyExisted, env);
  const envUpdates: Record<string, string> = {};

  Object.assign(envUpdates, await configureCryptoSecret(env, mode));
  Object.assign(envUpdates, await configureDiscordToken({ ...env, ...envUpdates }, mode));
  const database = await configureDatabase({ ...env, ...envUpdates }, mode, scan);
  Object.assign(envUpdates, database.values);

  if (Object.keys(envUpdates).length > 0) {
    upsertEnvKeys(ENV_PATH, envUpdates, { overwrite: mode === "reconfigure" });
    log.success("Updated .env.");
  } else {
    log.info(".env unchanged.");
  }

  if (database.startDockerDatabase) {
    await maybeStartDockerDatabase(scan);
  }

  await runBunInstall();

  if (options.showCompletion ?? true) {
    printSetupComplete("Base Install Complete");
  }
}

async function runSetupModule(module: SetupModule, ctx: SetupContext): Promise<void> {
  let result: "done" | "guided" | "skipped";
  try {
    result = await module.run(ctx);
  } catch (error) {
    log.warn(`${module.label} failed; continuing because Full Install extras are optional.`, error);
    log.info("You can re-run Full Install after fixing the issue.");
    return;
  }

  if (result === "done") {
    log.success(`${module.label} complete.`);
  } else if (result === "guided") {
    log.info(`${module.label} needs the guided step(s) shown above.`);
  } else {
    log.info(`${module.label} skipped.`);
  }
}

async function runFullInstall(scan: PrereqScan): Promise<void> {
  log.section("Full Install");
  log.info("Full Install runs Base Install, then optional database and AI helper setup.");
  await runBaseInstall(scan, { showCompletion: false });

  const ctx = buildContext(scan);
  for (const module of getFullInstallModules()) {
    await runSetupModule(module, ctx);
  }

  printSetupComplete("Full Install Complete");
}

async function runInteractiveMenu(scan: PrereqScan): Promise<void> {
  const selected = await selectMenu<SetupMode>("TomoriBot setup", [
    {
      id: "full",
      label: "(Recommended) Full Install",
      description: "Base Install plus pgvector, pg_cron, and tokenizer assets.",
    },
    {
      id: "base",
      label: "Base Install",
      description: "Required first run only: .env, Discord token, PostgreSQL, dependencies.",
    },
  ]);

  if (selected.id === "base") {
    await runBaseInstall(scan);
    return;
  }

  await runFullInstall(scan);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));

  if (flags.has("--help") || flags.has("-h")) {
    printHelp();
    return;
  }
  if (flags.has("--base") && flags.has("--full")) {
    throw new Error("Choose either --base or --full, not both.");
  }

  console.log(pc.bold("\nTomoriBot Setup Wizard\n"));
  const scan = await scanPrereqs();

  if (flags.has("--full")) {
    await runFullInstall(scan);
    return;
  }

  if (flags.has("--base") || isNonInteractiveMode()) {
    await runBaseInstall(scan);
    return;
  }

  await runInteractiveMenu(scan);
}

main().catch((error) => {
  log.error("Setup failed:", error);
  process.exit(1);
});
