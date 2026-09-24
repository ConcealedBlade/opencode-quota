import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";

const CONSOLE_API_URL = "https://opencode.ai/console/api";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";
const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console session expired or invalid — paste a fresh __Host-console_session cookie as consoleSessionCookie";

/**
 * The OpenCode Console reports amounts in micro-cents:
 * one US dollar is 100,000,000 micro-cents (billing units).
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

export interface OpenCodeZenBillingData {
  balance: number;
  monthlyLimit: number | null;
  monthlyUsage: number | null;
  lastPayment: number | null;
  reload: boolean;
  reloadAmount: number | null;
  reloadTrigger: number | null;
}

export type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData }
  | { success: false; error: string };

type ConsoleRoute =
  | "billing/status"
  | "billing/account"
  | "billing/auto-recharge"
  | "usage/cost-by-day";

type ConsoleRouteResult<T> = { success: true; data: T } | { success: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Console micro-cent amounts arrive as decimal strings; numbers are accepted too. */
function parseMicroCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return null;
}

function invalidResponse(): never {
  throw new Error("Unexpected OpenCode Console response");
}

function parseDollars(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return invalidResponse();
}

function parseBalance(json: unknown): number {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  return balance === null ? invalidResponse() : Math.max(0, balance);
}

/** Returns the credit limit in USD, or null when the account has no limit. */
function parseCreditLimit(json: unknown): number | null {
  const value = asRecord(json)?.creditLimitMicroCents;
  if (value === null) return null;

  const limit = parseMicroCents(value);
  return limit === null ? invalidResponse() : limit / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
}

function parseAutoRecharge(
  json: unknown,
): Pick<OpenCodeZenBillingData, "reload" | "reloadAmount" | "reloadTrigger"> {
  const autoRecharge = asRecord(json);
  if (!autoRecharge || typeof autoRecharge.enabled !== "boolean") return invalidResponse();

  return {
    reload: autoRecharge.enabled,
    reloadAmount: parseDollars(autoRecharge.rechargeAmountDollars),
    reloadTrigger: parseDollars(autoRecharge.thresholdDollars),
  };
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Sums the current UTC month's daily costs in micro-cents; an empty list means no usage. */
function parseMonthlyUsage(json: unknown, now: Date): number {
  if (!Array.isArray(json)) return invalidResponse();

  const month = currentUtcMonth(now);
  let total = 0;
  for (const item of json) {
    const day = asRecord(item);
    const cost = parseMicroCents(day?.totalCostMicroCents);
    if (typeof day?.date !== "string" || cost === null) return invalidResponse();
    if (day.date.slice(0, 7) === month) total += cost;
  }
  return total;
}

function sanitizeMessage(text: string, secrets: string[] = [], maxLength = 120): string {
  let sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return (sanitized || "unknown").slice(0, maxLength);
}

async function fetchConsoleRoute<T>(params: {
  route: ConsoleRoute;
  workspaceId: string;
  consoleSessionCookie: string;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  try {
    return await fetchWithTimeout(`${CONSOLE_API_URL}/${params.route}`, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          Cookie: `__Host-console_session=${params.consoleSessionCookie}`,
          "x-org-id": params.workspaceId,
        },
      },
      timeoutMs: params.timeoutMs,
      consume: async (response): Promise<ConsoleRouteResult<T>> => {
        if (
          (response.status >= 300 && response.status < 400) ||
          response.status === 401 ||
          response.status === 403
        ) {
          return { success: false, error: SESSION_ERROR };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `OpenCode Console ${params.route} error ${response.status}`,
          };
        }
        if (response.headers.get("content-type")?.includes("text/html")) {
          return { success: false, error: SESSION_ERROR };
        }

        const text = await response.text();
        try {
          return { success: true, data: params.parse(JSON.parse(text)) };
        } catch {
          return {
            success: false,
            error: `Could not parse OpenCode Console ${params.route} response`,
          };
        }
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), [
        params.consoleSessionCookie,
        params.workspaceId,
      ]),
    };
  }
}

export async function queryOpenCodeZenQuota(
  workspaceId: string,
  consoleSessionCookie: string,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const request = {
    workspaceId,
    consoleSessionCookie,
    timeoutMs: options.requestTimeoutMs ?? CONSOLE_TIMEOUT_MS,
  };
  const now = new Date();
  const [balance, creditLimit, autoRecharge, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  if (!balance.success) return balance;
  if (!creditLimit.success) return creditLimit;
  if (!autoRecharge.success) return autoRecharge;
  if (!monthlyUsage.success) return monthlyUsage;

  return {
    success: true,
    data: {
      balance: balance.data,
      monthlyLimit: creditLimit.data,
      monthlyUsage: monthlyUsage.data,
      lastPayment: null,
      ...autoRecharge.data,
    },
  };
}
