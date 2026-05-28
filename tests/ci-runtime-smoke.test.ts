import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { stopProcess } from "../scripts/ci-runtime-smoke.mjs";

const parentScript = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: "ignore"
});

if (process.send) {
  process.send({ pid: child.pid });
}

setInterval(() => {}, 1000);
`;

const itOnPosix = process.platform === "win32" ? it.skip : it;

describe("runtime smoke process cleanup", () => {
  itOnPosix("terminates descendant processes in the spawned process group", async () => {
    const parent = spawn(process.execPath, ["-e", parentScript], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let descendantPid: number | undefined;

    try {
      descendantPid = await waitForDescendantPid(parent);
      expect(isProcessRunning(descendantPid)).toBe(true);

      await stopProcess(parent, {
        terminateTimeoutMs: 500,
        killTimeoutMs: 500
      });

      expect(await waitUntilStopped(parent.pid, 1_000)).toBe(true);
      expect(await waitUntilStopped(descendantPid, 1_000)).toBe(true);
    } finally {
      cleanupProcessGroup(parent.pid);
      cleanupProcess(descendantPid);
    }
  });
});

function waitForDescendantPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for descendant process pid."));
    }, 1_000);

    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Parent process exited before sending descendant pid."));
    };
    const onMessage = (message: unknown) => {
      const pid = typeof message === "object" && message !== null && "pid" in message ? message.pid : undefined;
      if (typeof pid !== "number") {
        cleanup();
        reject(new Error("Parent process sent an invalid descendant pid."));
        return;
      }
      cleanup();
      resolve(pid);
    };

    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

async function waitUntilStopped(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessRunning(pid);
}

function isProcessRunning(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return false;
    }
    return true;
  }
}

function cleanupProcessGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    cleanupProcess(pid);
  }
}

function cleanupProcess(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup for failed assertions.
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
