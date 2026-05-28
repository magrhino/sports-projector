import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const smokePort = Number(process.env.CI_RUNTIME_SMOKE_PORT || "18080");
const useProcessGroupSignals = process.platform !== "win32";

async function main() {
  await smokeMcpScript();
  await smokeWebScript();
}

async function smokeMcpScript() {
  const child = spawnNpm(["run", "mcp"]);
  let output = "";

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(
      () => {
        if (output.includes("sports-projector running on stdio")) {
          return true;
        }
        if (hasExited(child)) {
          throw new Error(`npm run mcp exited before startup.\n${output}`);
        }
        return false;
      },
      "npm run mcp startup",
      10_000
    );
  } finally {
    await stopProcess(child);
  }
}

async function smokeWebScript() {
  const publicDir = await createSmokePublicDir();
  const child = spawnNpm(["run", "web"], {
    PORT: String(smokePort),
    SPORTS_PROJECTOR_PUBLIC_DIR: publicDir,
    SPORTS_PROJECTOR_HISTORICAL_REFRESH_ENABLED: "false",
    SPORTS_PROJECTOR_LIVE_TRACKING_ENABLED: "false"
  });
  let output = "";

  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitFor(
      async () => {
        if (hasExited(child)) {
          throw new Error(`npm run web exited before HTTP readiness.\n${output}`);
        }
        try {
          const response = await fetchWithTimeout(`http://127.0.0.1:${smokePort}/`, 1_000);
          return response.ok;
        } catch {
          return false;
        }
      },
      "npm run web HTTP readiness",
      15_000,
      () => output
    );

    const root = await fetchText(`http://127.0.0.1:${smokePort}/`);
    if (!root.includes("Sports Projector")) {
      throw new Error("web root did not serve the Sports Projector app shell.");
    }

    const settings = await fetchJson(`http://127.0.0.1:${smokePort}/api/settings`);
    if (!settings || typeof settings !== "object" || !("settings" in settings)) {
      throw new Error("/api/settings did not return the expected settings payload.");
    }
  } finally {
    await stopProcess(child);
    await rm(publicDir, { recursive: true, force: true });
  }
}

async function createSmokePublicDir() {
  const publicDir = await mkdtemp(path.join(tmpdir(), "sports-projector-smoke-"));
  await writeFile(
    path.join(publicDir, "index.html"),
    "<!doctype html><html><head><title>Sports Projector</title></head><body>Sports Projector</body></html>\n",
    "utf-8"
  );
  return publicDir;
}

function spawnNpm(args, env = {}) {
  return spawn(npmCommand, args, {
    env: {
      ...process.env,
      ...env
    },
    detached: useProcessGroupSignals,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitFor(predicate, label, timeoutMs, output = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(250);
  }
  const capturedOutput = output().trim();
  const outputDetails = capturedOutput ? `\n${capturedOutput}` : "";
  throw new Error(`Timed out waiting for ${label}.${outputDetails}`);
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url, 3_000);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }
  return response.text();
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url, 3_000);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}.`);
  }
  return response.json();
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function stopProcess(
  child,
  { terminateTimeoutMs = 2_000, killTimeoutMs = 2_000 } = {}
) {
  if (hasExited(child)) {
    return;
  }

  signalProcess(child, "SIGTERM");
  const exited = await waitForExitWithin(child, terminateTimeoutMs);

  if (!exited && !hasExited(child)) {
    signalProcess(child, "SIGKILL");
    const killed = await waitForExitWithin(child, killTimeoutMs);
    if (!killed && !hasExited(child)) {
      const pid = child.pid === undefined ? "unknown" : child.pid;
      throw new Error(`Timed out waiting for process ${pid} to exit after SIGKILL.`);
    }
  }
}

function signalProcess(child, signal) {
  if (useProcessGroupSignals && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isNoSuchProcessError(error)) {
        child.kill(signal);
      }
      return;
    }
  }

  child.kill(signal);
}

async function waitForExitWithin(child, timeoutMs) {
  return Promise.race([
    waitForExit(child),
    delay(timeoutMs).then(() => false)
  ]);
}

function waitForExit(child) {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve(true));
  });
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function isNoSuchProcessError(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
