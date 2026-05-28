import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const smokePort = Number(process.env.CI_RUNTIME_SMOKE_PORT || "18080");

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
  const child = spawnNpm(["run", "web"], {
    PORT: String(smokePort),
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
      15_000
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
  }
}

function spawnNpm(args, env = {}) {
  return spawn(npmCommand, args, {
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
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

async function stopProcess(child) {
  if (hasExited(child)) {
    return;
  }

  child.kill("SIGTERM");
  const exited = await Promise.race([
    waitForExit(child),
    delay(2_000).then(() => false)
  ]);

  if (!exited && !hasExited(child)) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
