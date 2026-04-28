import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const ADMIN_TOKEN_HEADER = "x-sports-projector-admin-token";

export function isAuthorizedAdminRequest(request: IncomingMessage, adminToken: string | null | undefined): boolean {
  if (isLoopbackAddress(request.socket.remoteAddress)) {
    return true;
  }

  const expectedToken = normalizeToken(adminToken);
  const providedToken = headerValue(request, ADMIN_TOKEN_HEADER);
  return expectedToken !== null && providedToken !== undefined && safeTokenEqual(providedToken, expectedToken);
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1" || /^127\./.test(address);
}

function normalizeToken(token: string | null | undefined): string | null {
  const normalized = token?.trim();
  return normalized ? normalized : null;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
