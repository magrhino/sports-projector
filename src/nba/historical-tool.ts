import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  HistoricalProjectionClient,
  HistoricalProjectionError
} from "./historical-client.js";
import { makeResponse, nowIso } from "../lib/response.js";
import { IsoDateSchema, TeamQuerySchema } from "../lib/validation.js";

const HISTORICAL_CAVEATS = [
  "Informational projection only.",
  "Historical artifact quality depends on local artifact freshness and leak-free feature snapshots.",
  "Live in-game state is not included in this historical model."
];
const DIAGNOSTIC_TEXT_MAX_CHARS = 2000;
const DIAGNOSTIC_MESSAGE_MAX_CHARS = 500;

interface HistoricalErrorDiagnosticText {
  text: string;
  truncated: boolean;
  original_chars: number;
  max_chars: number;
  redacted: boolean;
}

interface HistoricalErrorDiagnostics {
  message?: HistoricalErrorDiagnosticText;
  stderr?: HistoricalErrorDiagnosticText;
  stdout?: HistoricalErrorDiagnosticText;
}

interface HistoricalErrorData {
  error: string;
  code: string;
  diagnostics?: HistoricalErrorDiagnostics;
}

export const HistoricalProjectionInputSchema = z.object({
  home_team: TeamQuerySchema,
  away_team: TeamQuerySchema,
  game_date: IsoDateSchema,
  season: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "season must be YYYY-YY")
    .optional(),
  market_total: z.number().positive().optional(),
  market_spread: z.number().optional(),
  days_rest_home: z.number().int().min(0).max(30).optional(),
  days_rest_away: z.number().int().min(0).max(30).optional(),
  include_debug: z.boolean().default(false)
});

export function registerHistoricalTools(server: McpServer, client: HistoricalProjectionClient): void {
  server.registerTool(
    "project_nba_historical_score",
    {
      description:
        "Project an NBA matchup score from local historical model artifacts. Projection-only output; live in-game state is not included.",
      inputSchema: HistoricalProjectionInputSchema
    },
    async (input) => {
      try {
        const data = await client.project(input);
        return makeResponse({
          source: "historical",
          fetched_at: nowIso(),
          source_url: null,
          cache_status: "not_applicable",
          summary: "Projected an NBA matchup score from local historical artifacts.",
          data,
          caveats: HISTORICAL_CAVEATS
        });
      } catch (error) {
        return makeResponse({
          source: "historical",
          fetched_at: nowIso(),
          source_url: null,
          cache_status: "not_applicable",
          summary: "Unable to project NBA historical score from local artifacts.",
          data: historicalErrorData(error),
          caveats: HISTORICAL_CAVEATS
        });
      }
    }
  );
}

function historicalErrorData(error: unknown): HistoricalErrorData {
  const data: HistoricalErrorData = {
    error: error instanceof Error ? error.message : String(error),
    code: error instanceof HistoricalProjectionError ? error.code : "unknown"
  };

  if (error instanceof HistoricalProjectionError) {
    const diagnostics = historicalErrorDiagnostics(error.details);
    if (diagnostics) {
      data.diagnostics = diagnostics;
    }
  }

  return data;
}

function historicalErrorDiagnostics(
  details: Record<string, unknown> | undefined
): HistoricalErrorDiagnostics | undefined {
  if (!details) {
    return undefined;
  }

  const diagnostics: HistoricalErrorDiagnostics = {};
  const message = diagnosticString(details.message);
  const stderr = diagnosticString(details.stderr);
  const stdout = diagnosticString(details.stdout);

  if (message) {
    diagnostics.message = boundedDiagnosticText(message, DIAGNOSTIC_MESSAGE_MAX_CHARS);
  }
  if (stderr) {
    diagnostics.stderr = boundedDiagnosticText(stderr, DIAGNOSTIC_TEXT_MAX_CHARS);
  }
  if (stdout) {
    diagnostics.stdout = boundedDiagnosticText(stdout, DIAGNOSTIC_TEXT_MAX_CHARS);
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}

function diagnosticString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function boundedDiagnosticText(value: string, maxChars: number): HistoricalErrorDiagnosticText {
  const { text: sanitized, redacted } = sanitizeDiagnosticText(value);
  const chars = Array.from(sanitized);
  const truncated = chars.length > maxChars;
  return {
    text: truncated ? chars.slice(0, maxChars).join("") : sanitized,
    truncated,
    original_chars: chars.length,
    max_chars: maxChars,
    redacted
  };
}

function sanitizeDiagnosticText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = value;
  const redact = (_match: string, prefix: string): string => {
    redacted = true;
    return `${prefix}[redacted]`;
  };

  text = text.replace(/\b([A-Z][A-Z0-9_]{1,}\s*=\s*)(["'])[^"'\n\r]*\2/g, redact);
  text = text.replace(/\b([A-Z][A-Z0-9_]{1,}\s*=\s*)([^\s'"`,;]+)/g, redact);
  text = text.replace(
    /\b((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic)?\s*[^\s,;]+/gi,
    redact
  );
  text = text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, redact);
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|credential)[A-Za-z0-9_.-]*\s*[:=]\s*)([^\s,;]+)/gi,
    redact
  );
  text = text.replace(
    /(["']?[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|credential)[A-Za-z0-9_.-]*["']?\s*:\s*)["'][^"']*["']/gi,
    (_match, prefix: string) => {
      redacted = true;
      return `${prefix}"[redacted]"`;
    }
  );

  return { text, redacted };
}
