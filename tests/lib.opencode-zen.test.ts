import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse(url);
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { queryOpenCodeZenQuota } from "../src/lib/opencode-zen.js";

const CONSOLE_API = "https://opencode.ai/console/api";
const SESSION_ERROR =
  "OpenCode Console session expired or invalid — paste a fresh __Host-console_session cookie as consoleSessionCookie";

// Payloads captured from a real account by the maintainer (org id replaced).
const STATUS = {
  billingMode: "prepaid",
  mode: "pay-as-you-go",
  balanceMicroCents: "0",
  creditLimitMicroCents: null,
  availableMicroCents: "0",
  canPurchaseCredits: true,
  canEnableAutoRecharge: true,
  canEnrollInPrepaid: false,
};
const ACCOUNT = {
  orgId: "wrk_ABC",
  creditLimitMicroCents: null,
  createdAt: "2026-05-15T16:03:51.000Z",
  updatedAt: "2026-06-15T16:07:20.000Z",
};
const AUTO_RECHARGE = {
  enabled: false,
  thresholdDollars: 5,
  rechargeAmountDollars: 20,
  pending: false,
  failureReason: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routes(overrides: Record<string, () => Response> = {}): void {
  const payloads: Record<string, () => Response> = {
    "billing/status": () => json(STATUS),
    "billing/account": () => json(ACCOUNT),
    "billing/auto-recharge": () => json(AUTO_RECHARGE),
    "usage/cost-by-day": () => json([]),
    ...overrides,
  };
  mocks.fetchResponse.mockImplementation(async (url: string) => {
    const route = url.slice(`${CONSOLE_API}/`.length);
    const payload = payloads[route];
    if (!payload) throw new Error(`unexpected url ${url}`);
    return payload();
  });
}

describe("queryOpenCodeZenQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchResponse.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls the four Console routes with the session cookie and org id", async () => {
    routes();

    await queryOpenCodeZenQuota("wrk_abc", "session-value", { requestTimeoutMs: 4_000 });

    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => url).sort()).toEqual([
      `${CONSOLE_API}/billing/account`,
      `${CONSOLE_API}/billing/auto-recharge`,
      `${CONSOLE_API}/billing/status`,
      `${CONSOLE_API}/usage/cost-by-day`,
    ]);
    for (const [, options] of mocks.fetchWithTimeout.mock.calls) {
      expect(options).toMatchObject({
        request: {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            Cookie: "__Host-console_session=session-value",
            "x-org-id": "wrk_abc",
          },
        },
        timeoutMs: 4_000,
      });
    }
  });

  it("parses the real empty-account payloads", async () => {
    routes();

    await expect(queryOpenCodeZenQuota("wrk_abc", "session-value")).resolves.toEqual({
      success: true,
      data: {
        balance: 0,
        monthlyLimit: null,
        monthlyUsage: 0,
        lastPayment: null,
        reload: false,
        reloadAmount: 20,
        reloadTrigger: 5,
      },
    });
  });

  it("keeps micro-cents as billing units and sums only the current month's costs", async () => {
    routes({
      "billing/status": () => json({ ...STATUS, balanceMicroCents: "4250000000" }),
      "billing/account": () => json({ ...ACCOUNT, creditLimitMicroCents: "10000000000" }),
      "billing/auto-recharge": () => json({ ...AUTO_RECHARGE, enabled: true }),
      "usage/cost-by-day": () =>
        json([
          { date: "2026-08-31", totalCostMicroCents: "900000000" },
          { date: "2026-09-01", totalCostMicroCents: "500000000" },
          { date: "2026-09-24", totalCostMicroCents: "75000000" },
        ]),
    });

    await expect(queryOpenCodeZenQuota("wrk_abc", "session-value")).resolves.toEqual({
      success: true,
      data: {
        balance: 4_250_000_000,
        monthlyLimit: 100,
        monthlyUsage: 575_000_000,
        lastPayment: null,
        reload: true,
        reloadAmount: 20,
        reloadTrigger: 5,
      },
    });
  });

  it("clamps a negative balance to zero", async () => {
    routes({ "billing/status": () => json({ ...STATUS, balanceMicroCents: "-14496" }) });

    const result = await queryOpenCodeZenQuota("wrk_abc", "session-value");

    expect(result).toMatchObject({ success: true, data: { balance: 0 } });
  });

  it.each([
    [
      "302 redirect",
      () => new Response(null, { status: 302, headers: { location: "/console/login" } }),
    ],
    ["401", () => new Response("unauthorized", { status: 401 })],
    ["403", () => new Response("forbidden", { status: 403 })],
    [
      "login page",
      () =>
        new Response("<html>Sign in</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ],
  ])("reports an expired or invalid session for a %s", async (_name, sessionResponse) => {
    routes({
      "billing/status": sessionResponse,
      "billing/account": sessionResponse,
      "billing/auto-recharge": sessionResponse,
      "usage/cost-by-day": sessionResponse,
    });

    const result = await queryOpenCodeZenQuota("wrk_abc", "session-secret");

    expect(result).toEqual({ success: false, error: SESSION_ERROR });
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it("does not expose an HTTP response body", async () => {
    const secretBody = "private-body-session-secret";
    routes({ "billing/status": () => new Response(secretBody, { status: 500 }) });

    const result = await queryOpenCodeZenQuota("wrk_abc", "session-secret");

    expect(result).toEqual({
      success: false,
      error: "OpenCode Console billing/status error 500",
    });
    expect(JSON.stringify(result)).not.toContain(secretBody);
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });

  it.each([
    ["billing/status", () => json({ ...STATUS, balanceMicroCents: undefined })],
    ["billing/status", () => new Response("not json", { status: 200 })],
    ["billing/account", () => json({ orgId: "wrk_ABC" })],
    ["billing/auto-recharge", () => json({ ...AUTO_RECHARGE, enabled: "no" })],
    ["usage/cost-by-day", () => json({ days: [] })],
    ["usage/cost-by-day", () => json([{ date: "2026-09-01", totalCostMicroCents: "abc" }])],
  ])("returns a stable parse error for a malformed %s response", async (route, payload) => {
    routes({ [route]: payload });

    await expect(queryOpenCodeZenQuota("wrk_abc", "session-value")).resolves.toEqual({
      success: false,
      error: `Could not parse OpenCode Console ${route} response`,
    });
  });

  it("sanitizes network and timeout errors and redacts configured secrets", async () => {
    mocks.fetchResponse.mockRejectedValue(
      new Error("\u001b[31mtimeout for wrk_secret with session-secret\nretry\u001b[0m"),
    );

    const result = await queryOpenCodeZenQuota("wrk_secret", "session-secret");

    expect(result).toEqual({
      success: false,
      error: "timeout for [redacted] with [redacted] retry",
    });
    expect(JSON.stringify(result)).not.toContain("wrk_secret");
    expect(JSON.stringify(result)).not.toContain("session-secret");
  });
});
