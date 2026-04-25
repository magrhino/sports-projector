import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createHttpHandler } from "../src/http/index.js";

describe("createHttpHandler", () => {
  it("does not parse request URLs against the user-controlled Host header", async () => {
    const response = createResponseDouble();
    await createHttpHandler()(
      {
        method: "GET",
        url: "/api/unknown",
        headers: { host: "localhost:bad" }
      } as IncomingMessage,
      response
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('{"error":"API route not found."}');
  });
});

function createResponseDouble(): ServerResponse & { body: string } {
  return {
    statusCode: 0,
    body: "",
    setHeader() {
      return this;
    },
    end(body?: string | Buffer) {
      this.body = body === undefined ? "" : body.toString();
      return this;
    }
  } as ServerResponse & { body: string };
}
