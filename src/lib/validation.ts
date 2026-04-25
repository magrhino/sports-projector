import { z } from "zod";

export const LEAGUES = ["nba", "nfl", "mlb", "nhl"] as const;
export type League = (typeof LEAGUES)[number];

export interface LeagueConfig {
  sport: string;
  league: League;
  periodName: "quarter" | "inning" | "period";
  regulationSeconds: number;
}

export const LEAGUE_CONFIG: Record<League, LeagueConfig> = {
  nba: {
    sport: "basketball",
    league: "nba",
    periodName: "quarter",
    regulationSeconds: 48 * 60
  },
  nfl: {
    sport: "football",
    league: "nfl",
    periodName: "quarter",
    regulationSeconds: 60 * 60
  },
  mlb: {
    sport: "baseball",
    league: "mlb",
    periodName: "inning",
    regulationSeconds: 9 * 20 * 60
  },
  nhl: {
    sport: "hockey",
    league: "nhl",
    periodName: "period",
    regulationSeconds: 60 * 60
  }
};

export const LeagueSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(LEAGUES)
) as z.ZodType<League>;

export const EspnDateSchema = z
  .string()
  .trim()
  .regex(/^\d{8}$|^\d{4}-\d{2}-\d{2}$/, "Date must be YYYYMMDD or YYYY-MM-DD")
  .transform((value) => value.replaceAll("-", ""))
  .refine(isValidCompactDate, "Date must be a real calendar date");

export const IsoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
  .refine((value) => isValidCompactDate(value.replaceAll("-", "")), "Date must be a real calendar date");

export const OptionalEspnDateSchema = EspnDateSchema.optional();

export const EventIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,30}$/, "ESPN event_id must be numeric");

export const TeamQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((value) => !looksLikeUrl(value), "Team must not be a URL")
  .refine(
    (value) => /^[A-Za-z0-9 .&'_-]+$/.test(value),
    "Team may only contain letters, numbers, spaces, periods, apostrophes, ampersands, underscores, or hyphens"
  );

export const KalshiTickerSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z0-9._-]+$/.test(value), "Kalshi ticker contains unsupported characters");

export const KalshiCursorSchema = z
  .string()
  .trim()
  .max(1000)
  .regex(/^[A-Za-z0-9._~=-]*$/, "Kalshi cursor contains unsupported characters");

export const SafeSearchTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !looksLikeUrl(value), "Search text must not be a URL")
  .refine((value) => !/[\u0000-\u001F\u007F]/.test(value), "Search text contains control characters");

export const KalshiStatusSchema = z.enum([
  "open",
  "closed",
  "settled",
  "initialized",
  "all"
]);

export const LimitSchema = z.number().int().min(1).max(100).default(20);
export const KalshiLargeLimitSchema = z.number().int().min(1).max(1000).default(100);
export const DepthSchema = z.number().int().min(0).max(100).default(10);
export const UnixTimestampSchema = z.number().int().min(0);

export function looksLikeUrl(value: string): boolean {
  return /:\/\//.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value) || /[/?#\\]/.test(value);
}

export function getLeagueConfig(league: League): LeagueConfig {
  return LEAGUE_CONFIG[league];
}

export function assertAllowlistedUrl(url: URL, allowedOrigins: readonly string[]): void {
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(`Blocked non-allowlisted URL origin: ${url.origin}`);
  }
}

function isValidCompactDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31
  ];
  return day <= daysInMonth[month - 1];
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
