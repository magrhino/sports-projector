import type { IncomingMessage } from "node:http";
import { DEFAULT_SETTINGS, SettingsStore } from "../lib/settings.js";
import { isAuthorizedAdminRequest } from "./admin-auth.js";

const MAX_SETTINGS_BODY_BYTES = 16 * 1024;

export function getSettings(store: SettingsStore): { status: number; body: unknown } {
  try {
    return {
      status: 200,
      body: {
        settings: store.read(),
        defaults: DEFAULT_SETTINGS
      }
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

export async function updateSettings(
  request: IncomingMessage,
  store: SettingsStore,
  options: { adminToken?: string | null } = {}
): Promise<{ status: number; body: unknown }> {
  if (!isAuthorizedAdminRequest(request, options.adminToken)) {
    return {
      status: 403,
      body: {
        error: "Settings updates require a local admin request."
      }
    };
  }

  try {
    const patch = await readJsonBody(request);
    return {
      status: 200,
      body: {
        settings: store.update(patch),
        defaults: DEFAULT_SETTINGS
      }
    };
  } catch (error) {
    return {
      status: 400,
      body: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_SETTINGS_BODY_BYTES) {
      throw new Error("Settings update body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) {
    return {};
  }
  return JSON.parse(body) as unknown;
}
