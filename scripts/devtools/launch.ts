#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import pc from "picocolors";
import { resolvePythonExe } from "../lib/pyenv";

config();

// scripts/devtools/launch.ts
//
//   bun run launch [--searxng] [--crawl4ai] [--qwen3tts] [--chatterbox] [--irodoritts] [--voxcpm2]
//
//   Starts requested sidecar services, waits for them to be ready, then
//   launches the bot in watch mode (equivalent to `bun run dev`).
//
//   Docker sidecars are started via docker inspect/start/run and polled until
//   their healthcheck reports "healthy". Python sidecars are spawned directly
//   from their pre-built venv and polled through their JSON health endpoint.
//
//   Press Ctrl+C to stop everything.

const ROOT = process.cwd();


const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));

if (flags.has("help") || flags.has("h")) {
  console.log(`
${pc.bold("bun run launch")} — start sidecars + TomoriBot in watch mode

${pc.bold("Usage:")}
  bun run launch [options]

${pc.bold("Options:")}
  --searxng     Start the SearXNG metasearch Docker container (port 8080 by default)
  --crawl4ai    Start the Crawl4AI browser-render Docker container (port 11235 by default)
  --qwen3tts    Start the Qwen3-TTS Python server (requires venv setup)
  --chatterbox  Start the Chatterbox TTS Python server (requires venv setup)
  --irodoritts  Start the IrodoriTTS Python server (requires venv setup)
  --voxcpm2     Start the VoxCPM2 Python server (requires venv setup)
  --whisperx    Start the WhisperX transcription Python server (requires venv setup)
  --help        Show this message

${pc.bold("Examples:")}
  bun run launch
  bun run launch --searxng --crawl4ai
  bun run launch --qwen3tts --searxng
  bun run launch --voxcpm2
`);
  process.exit(0);
}


interface DockerSidecar {
  kind: "docker";
  /** docker container name */
  containerName: string;
  /** image to pull if container doesn't exist */
  image: string;
  /** args passed after "docker run" when creating a fresh container */
  runArgs: string[];
  /** milliseconds to wait for healthcheck before aborting (default 120s) */
  healthTimeoutMs?: number;
  /**
   * HTTP URL to probe as a fallback when the container has no Docker healthcheck
   * (e.g. an existing container created before --health-cmd was added to runArgs).
   * Polled every 2s; a 2xx response is treated as healthy.
   */
  httpHealthUrl?: string;
}

interface PythonSidecar {
  kind: "python";
  displayName: string;
  /** path to the .venv directory, relative to ROOT */
  venvRelPath: string;
  /** path to the server script, relative to ROOT */
  scriptRelPath: string;
  /** extra args passed to the script */
  scriptArgs?: string[];
  /** JSON health endpoint used to distinguish loading from ready. */
  healthUrl: string;
  /** Status values that mean the server can accept requests. */
  readyStatuses?: readonly string[];
  /** Maximum time to wait for the model to become ready. */
  healthTimeoutMs?: number;
}

type SidecarDef = DockerSidecar | PythonSidecar;

/** Registry of all supported --flag → sidecar definitions. */
const SIDECARS: Record<string, SidecarDef> = {
  searxng: {
    kind: "docker",
    containerName: "searxng",
    image: "searxng/searxng:latest",
    httpHealthUrl: "http://localhost:8080/healthz",
    runArgs: [
      "-d",
      "--name", "searxng",
      "-p", "8080:8080",
      "-v", `${ROOT}/servers/searxng:/etc/searxng:rw`,
      "-e", "SEARXNG_SECRET=dev-only-not-for-production",
      "--health-cmd", "wget -q --spider http://localhost:8080/healthz || exit 1",
      "--health-interval", "10s",
      "--health-timeout", "3s",
      "--health-retries", "5",
      "--health-start-period", "15s",
      "searxng/searxng:latest",
    ],
  },

  crawl4ai: {
    kind: "docker",
    containerName: "crawl4ai",
    image: "unclecode/crawl4ai:latest",
    // Crawl4AI has a longer first-run startup (model download), give it 3 min.
    healthTimeoutMs: 180_000,
    httpHealthUrl: "http://localhost:11235/health",
    runArgs: [
      "-d",
      "--name", "crawl4ai",
      "-p", "11235:11235",
      "--shm-size=3g",
      ...(process.env.CRAWL4AI_TOKEN ? ["-e", `CRAWL4AI_API_TOKEN=${process.env.CRAWL4AI_TOKEN}`] : []),
      "--health-cmd", "python -c \"import urllib.request; urllib.request.urlopen('http://localhost:11235/health', timeout=3).read()\"",
      "--health-interval", "10s",
      "--health-timeout", "5s",
      "--health-retries", "12",
      "--health-start-period", "45s",
      "unclecode/crawl4ai:latest",
    ],
  },

  qwen3tts: {
    kind: "python",
    displayName: "Qwen3-TTS",
    venvRelPath: "servers/tts/qwen3tts/.venv",
    scriptRelPath: "servers/tts/qwen3tts/server.py",
    healthUrl: `http://127.0.0.1:${process.env.TOMORI_TTS_PORT ?? "8012"}/health`,
    readyStatuses: ["ok", "idle"],
  },

  chatterbox: {
    kind: "python",
    displayName: "Chatterbox TTS",
    venvRelPath: "servers/tts/chatterbox/.venv",
    scriptRelPath: "servers/tts/chatterbox/server.py",
    healthUrl: `http://127.0.0.1:${process.env.TOMORI_TTS_PORT ?? "8011"}/health`,
  },

  irodoritts: {
    kind: "python",
    displayName: "IrodoriTTS",
    venvRelPath: "servers/tts/irodoritts/.venv",
    scriptRelPath: "servers/tts/irodoritts/server.py",
    healthUrl: `http://127.0.0.1:${process.env.TOMORI_TTS_PORT ?? "8013"}/health`,
  },

  voxcpm2: {
    kind: "python",
    displayName: "VoxCPM2",
    venvRelPath: "servers/tts/voxcpm2/.venv",
    scriptRelPath: "servers/tts/voxcpm2/server.py",
    healthUrl: `http://127.0.0.1:${process.env.VOXCPM2_PORT ?? process.env.TOMORI_TTS_PORT ?? "8016"}/health`,
  },

  whisperx: {
    kind: "python",
    displayName: "WhisperX",
    venvRelPath: "servers/stt/.venv",
    scriptRelPath: "servers/stt/whisperx_server.py",
    healthUrl: `http://127.0.0.1:${process.env.TOMORI_STT_PORT ?? process.env.TOMORI_TRANSCRIPTION_PORT ?? "8021"}/health`,
  },
};


/**
 * Checks whether a named Docker container exists (regardless of state).
 * Returns the container's current state ("running", "exited", etc.) or null
 * if the container does not exist.
 */
async function getContainerState(name: string): Promise<string | null> {
  const proc = Bun.spawn(
    ["docker", "inspect", "--format", "{{.State.Status}}", name],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await proc.exited;
  if (code !== 0) return null;
  return new Response(proc.stdout).text().then((t) => t.trim());
}

/**
 * Reads the Docker healthcheck status for a running container.
 * Returns "healthy", "unhealthy", "starting", or "" if no healthcheck is defined.
 */
async function getContainerHealth(name: string): Promise<string> {
  const proc = Bun.spawn(
    ["docker", "inspect", "--format", "{{.State.Health.Status}}", name],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
  return new Response(proc.stdout).text().then((t) => t.trim());
}

/**
 * Polls until the container is ready, using Docker's healthcheck when available
 * and falling back to an HTTP probe when the container has no healthcheck defined
 * (e.g. an existing container created before --health-cmd was added to runArgs).
 * Throws on timeout or a Docker "unhealthy" status.
 */
async function waitForHealthy(def: DockerSidecar, timeoutMs: number): Promise<void> {
  const { containerName, httpHealthUrl } = def;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const health = await getContainerHealth(containerName);

    if (health === "healthy") return;
    if (health === "unhealthy") throw new Error(`Container "${containerName}" reported unhealthy.`);

    // No Docker healthcheck on this container, so fall back to HTTP probe.
    if (health === "" && httpHealthUrl) {
      try {
        const res = await fetch(httpHealthUrl, { signal: AbortSignal.timeout(3_000) });
        if (res.ok) return;
      } catch {
      }
    }

    await Bun.sleep(2_000);
  }
  throw new Error(`Container "${containerName}" did not become healthy within ${timeoutMs / 1000}s.`);
}

type PythonHealthResult =
  | { kind: "ready"; ready: boolean }
  | { kind: "exit"; code: number }
  | { kind: "retry" };

async function probeJsonHealth(url: string, readyStatuses: readonly string[]): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("status" in payload)) return false;
    const status = payload.status;
    return typeof status === "string" && readyStatuses.includes(status);
  } catch {
    return false;
  }
}

async function waitForPythonReady(
  proc: ReturnType<typeof Bun.spawn>,
  def: PythonSidecar,
  timeoutMs: number,
): Promise<void> {
  const readyStatuses = def.readyStatuses ?? ["ok"];
  const processExit = proc.exited.then((code): PythonHealthResult => ({ kind: "exit", code }));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await Promise.race<PythonHealthResult>([
      probeJsonHealth(def.healthUrl, readyStatuses).then(
        (ready): PythonHealthResult => ({ kind: "ready", ready }),
      ),
      processExit,
      Bun.sleep(1_000).then((): PythonHealthResult => ({ kind: "retry" })),
    ]);

    if (result.kind === "exit") {
      throw new Error(`Process exited before readiness (exit ${result.code}).`);
    }
    if (result.kind === "ready" && result.ready) return;
  }

  throw new Error(`Server did not report a ready JSON status within ${timeoutMs / 1000}s.`);
}

/**
 * Ensures a Docker sidecar is running. Creates the container via "docker run"
 * if it doesn't exist, or resumes it with "docker start" if it does.
 * Waits for the container's healthcheck to pass before returning.
 */
async function ensureDockerSidecar(def: DockerSidecar): Promise<void> {
  const { containerName, healthTimeoutMs = 120_000 } = def;
  const label = pc.cyan(`[${containerName}]`);

  const state = await getContainerState(containerName);

  if (state === null) {
    console.log(`${label} Container not found. Running docker run...`);
    const run = Bun.spawn(["docker", "run", ...def.runArgs], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await run.exited;
    if (code !== 0) throw new Error(`docker run for "${containerName}" failed (exit ${code}).`);
  } else if (state !== "running") {
    console.log(`${label} Resuming existing container...`);
    const start = Bun.spawn(["docker", "start", containerName], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await start.exited;
    if (code !== 0) throw new Error(`docker start for "${containerName}" failed (exit ${code}).`);
  } else {
    console.log(`${label} Already running.`);
  }

  console.log(`${label} Waiting for healthcheck...`);
  await waitForHealthy(def, healthTimeoutMs);
  console.log(`${label} ${pc.green("Healthy ✓")}`);
}


/**
 * Spawns a Python sidecar server from its pre-built venv and waits for JSON readiness before
 * returning the handle.
 * Throws if the venv is missing (user must run setup first).
 */
async function startPythonSidecar(
  def: PythonSidecar,
  flagName: string,
): Promise<ReturnType<typeof Bun.spawn>> {
  const {
    displayName,
    venvRelPath,
    scriptRelPath,
    scriptArgs = [],
    healthTimeoutMs = Number.parseInt(process.env.TOMORI_TTS_STARTUP_TIMEOUT_MS ?? "300000", 10),
  } = def;
  const label = pc.magenta(`[${displayName}]`);

  const pythonExe = resolvePythonExe(venvRelPath);
  if (!existsSync(pythonExe)) {
    throw new Error(
      `${displayName} venv not found at "${join(ROOT, venvRelPath)}". ` +
      `Run the setup instructions in the docs before using --${flagName}.`,
    );
  }

  const scriptPath = join(ROOT, scriptRelPath);
  console.log(`${label} Starting...`);

  const proc = Bun.spawn([pythonExe, scriptPath, ...scriptArgs], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: ROOT,
  });

  console.log(`${label} Waiting for JSON readiness (up to ${healthTimeoutMs / 1000}s)...`);
  try {
    await waitForPythonReady(proc, def, healthTimeoutMs);
  } catch (error) {
    try { proc.kill(); } catch { /* already exited */ }
    throw new Error(`${displayName} did not become ready: ${error instanceof Error ? error.message : error}`);
  }
  console.log(`${label} ${pc.green("Ready ✓")}`);

  return proc;
}


async function main(): Promise<void> {
  const requested = [...flags].filter((f) => f in SIDECARS);
  const unknown = [...flags].filter((f) => !(f in SIDECARS) && f !== "help" && f !== "h");

  if (unknown.length > 0) {
    console.warn(pc.yellow(`Unknown flags: ${unknown.map((f) => `--${f}`).join(", ")} — ignoring.`));
  }

  const childProcesses: ReturnType<typeof Bun.spawn>[] = [];

  for (const flag of requested) {
    const def = SIDECARS[flag];
    try {
      if (def.kind === "docker") {
        await ensureDockerSidecar(def);
      } else {
        const proc = await startPythonSidecar(def, flag);
        childProcesses.push(proc);
      }
    } catch (err) {
      console.error(pc.red(`Failed to start sidecar "${flag}": ${err instanceof Error ? err.message : err}`));
      for (const p of childProcesses) p.kill();
      process.exit(1);
    }
  }

  console.log(`\n${pc.bold(pc.blue("[TomoriBot]"))} Starting bot in watch mode...\n`);
  const bot = Bun.spawn(["bun", "--watch", "src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    cwd: ROOT,
  });
  childProcesses.push(bot);

  // Graceful shutdown because kill all managed processes on Ctrl+C.
  let isShuttingDown = false;
  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${pc.yellow("[launch] Shutting down...")}`);
    for (const p of childProcesses) {
      try { p.kill(); } catch { /* already exited */ }
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for the bot to exit (its exit code becomes this process's exit code).
  const exitCode = await bot.exited;
  for (const p of childProcesses) {
    if (p !== bot) {
      try { p.kill(); } catch { /* already exited */ }
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(pc.red(`[launch] Fatal: ${err instanceof Error ? err.message : err}`));
  process.exit(1);
});
