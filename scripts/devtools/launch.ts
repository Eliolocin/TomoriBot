#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import pc from "picocolors";
import { resolvePythonExe } from "../lib/pyenv";

config();

// scripts/devtools/launch.ts
//
//   bun run launch [--searxng] [--crawl4ai] [--qwen3tts] [--chatterbox] [--irodoritts] [--cosyvoice3]
//
//   Starts requested sidecar services, waits for them to be ready, then
//   launches the bot in watch mode (equivalent to `bun run dev`).
//
//   Docker sidecars are started via docker inspect/start/run and polled until
//   their healthcheck reports "healthy". Python sidecars are spawned directly
//   from their pre-built venv and given a configurable startup delay.
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
  --cosyvoice3  Start the CosyVoice 3 Python server (requires venv setup)
  --whisperx    Start the WhisperX transcription Python server (requires venv setup)
  --help        Show this message

${pc.bold("Examples:")}
  bun run launch
  bun run launch --searxng --crawl4ai
  bun run launch --qwen3tts --searxng
  bun run launch --cosyvoice3
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
  /** milliseconds to wait after spawn before proceeding (default 3s) */
  startupDelayMs?: number;
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
      "-e", `SEARXNG_SECRET=dev-only-not-for-production`,
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
    startupDelayMs: 5_000,
  },

  chatterbox: {
    kind: "python",
    displayName: "Chatterbox TTS",
    venvRelPath: "servers/tts/chatterbox/.venv",
    scriptRelPath: "servers/tts/chatterbox/server.py",
    startupDelayMs: 5_000,
  },

  irodoritts: {
    kind: "python",
    displayName: "IrodoriTTS",
    venvRelPath: "servers/tts/irodoritts/.venv",
    scriptRelPath: "servers/tts/irodoritts/server.py",
    startupDelayMs: 8_000,
  },

  cosyvoice3: {
    kind: "python",
    displayName: "CosyVoice 3",
    venvRelPath: "servers/tts/cosyvoice3/.venv",
    scriptRelPath: "servers/tts/cosyvoice3/server.py",
    startupDelayMs: 15_000,
  },

  whisperx: {
    kind: "python",
    displayName: "WhisperX",
    venvRelPath: "servers/stt/.venv",
    scriptRelPath: "servers/stt/whisperx_server.py",
    startupDelayMs: 10_000,
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
 * Spawns a Python sidecar server from its pre-built venv and waits
 * `startupDelayMs` milliseconds for it to bind before returning the handle.
 * Throws if the venv is missing (user must run setup first).
 */
async function startPythonSidecar(def: PythonSidecar): Promise<ReturnType<typeof Bun.spawn>> {
  const { displayName, venvRelPath, scriptRelPath, scriptArgs = [], startupDelayMs = 3_000 } = def;
  const label = pc.magenta(`[${displayName}]`);

  const pythonExe = resolvePythonExe(venvRelPath);
  if (!existsSync(pythonExe)) {
    throw new Error(
      `${displayName} venv not found at "${join(ROOT, venvRelPath)}". ` +
      `Run the setup instructions in the docs before using --${displayName.toLowerCase().replace(/[^a-z]/g, "")}.`,
    );
  }

  const scriptPath = join(ROOT, scriptRelPath);
  console.log(`${label} Starting...`);

  const proc = Bun.spawn([pythonExe, scriptPath, ...scriptArgs], {
    stdout: "inherit",
    stderr: "inherit",
    cwd: ROOT,
  });

  // Give the Python HTTP server time to bind its port.
  console.log(`${label} Waiting ${startupDelayMs / 1000}s for server to initialize...`);
  await Bun.sleep(startupDelayMs);
  console.log(`${label} ${pc.green("Started ✓")}`);

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
        const proc = await startPythonSidecar(def);
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
