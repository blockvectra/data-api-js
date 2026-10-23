import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createDataClient, DEFAULT_BASE_URL, isDataApiError, type DataApiError, type paths } from "./index.js";

const API_KEY = "rgw_test_key";
const CHAIN = "robinhood_mainnet";
const TX_HASH = `0x${"ab".repeat(32)}`;

const META = {
  chain: CHAIN,
  chain_slug: "ROBINHOOD_MAINNET",
  chain_external_id: "eip155:4663",
  as_of_block: 1256,
  finalized_block: 1000,
  coverage: "full",
  refreshed_at: "2026-09-28T00:00:00Z",
} as const;

/** A `fetch` stand-in that records every `Request` and answers with `response`. */
function mockFetch(response: () => Response) {
  const calls: Request[] = [];
  const fetch = vi.fn(async (request: Request) => {
    calls.push(request);
    return response();
  });
  return { fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("createDataClient", () => {
  it("sends the key in x-api-key and builds the URL from the default base and {chain}", async () => {
    const { fetch, calls } = mockFetch(() => json(200, { data: [], meta: META }));
    const client = createDataClient({ apiKey: API_KEY, fetch });

    const { data, error } = await client.GET("/{chain}/status/freshness", {
      params: { path: { chain: CHAIN } },
    });

    expect(error).toBeUndefined();
    expect(data?.meta.finalized_block).toBe(1000);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${DEFAULT_BASE_URL}/${CHAIN}/status/freshness`);
    expect(calls[0].headers.get("x-api-key")).toBe(API_KEY);
  });

  it("honours a baseUrl override and serialises path and query parameters", async () => {
    const { fetch, calls } = mockFetch(() => json(200, { data: {}, meta: META }));
    const client = createDataClient({ apiKey: API_KEY, baseUrl: "http://127.0.0.1:8080/v1/data/", fetch });

    await client.GET("/{chain}/transactions/{hash}", {
      params: { path: { chain: CHAIN, hash: TX_HASH }, query: { include_logs: "true" } },
    });

    expect(calls[0].url).toBe(`http://127.0.0.1:8080/v1/data/${CHAIN}/transactions/${TX_HASH}?include_logs=true`);
    expect(calls[0].headers.get("x-api-key")).toBe(API_KEY);
  });

  it("surfaces a JSON error body as the typed `error`", async () => {
    const body: DataApiError = { error: { code: "not_found", message: "block 5 was not found" } };
    const { fetch } = mockFetch(() => json(404, body));
    const client = createDataClient({ apiKey: API_KEY, fetch });

    const { data, error, response } = await client.GET("/{chain}/blocks/{number}", {
      params: { path: { chain: CHAIN, number: 5 } },
    });

    expect(data).toBeUndefined();
    expect(response.status).toBe(404);
    expect(isDataApiError(error)).toBe(true);
    if (isDataApiError(error)) {
      expectTypeOf(error).toEqualTypeOf<DataApiError>();
      expect(error.error.code).toBe("not_found");
    }
  });

  it("returns no `error` for the empty-body 404 of a missing/unknown key — branch on response.status", async () => {
    const { fetch } = mockFetch(() => new Response(null, { status: 404, headers: { "Content-Length": "0" } }));
    const client = createDataClient({ apiKey: "rgw_unknown", fetch });

    const { data, error, response } = await client.GET("/{chain}/status/freshness", {
      params: { path: { chain: CHAIN } },
    });

    expect(data).toBeUndefined();
    expect(error).toBeUndefined();
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["spaces", "   "],
    ["tabs and newlines", " \t\r\n "],
    ["number", 12345],
    ["object", { key: "rgw_object_secret" }],
  ])("rejects an invalid apiKey (%s) synchronously and never calls fetch", (_label, apiKey) => {
    const { fetch } = mockFetch(() => json(200, { data: [], meta: META }));

    let thrown: unknown;
    try {
      createDataClient({ apiKey: apiKey as unknown as string, fetch });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toMatch(/apiKey/);
    expect((thrown as TypeError).message).not.toContain("rgw_object_secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a missing apiKey property without calling fetch", () => {
    const { fetch } = mockFetch(() => json(200, { data: [], meta: META }));
    expect(() => createDataClient({ fetch } as unknown as Parameters<typeof createDataClient>[0])).toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a non-empty key of any shape unchanged and leaves a server rejection to the server error handling", async () => {
    const body: DataApiError = { error: { code: "unauthorized", message: "invalid api key" } };
    const { fetch, calls } = mockFetch(() => json(401, body));
    const client = createDataClient({ apiKey: "not-an-rgw-key", fetch });

    const { error, response } = await client.GET("/{chain}/status/freshness", {
      params: { path: { chain: CHAIN } },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(calls[0].headers.get("x-api-key")).toBe("not-an-rgw-key");
    expect(response.status).toBe(401);
    expect(isDataApiError(error)).toBe(true);
    expect(error).toEqual(body);
  });

  it("exposes Retry-After on 429 alongside the error code", async () => {
    const { fetch } = mockFetch(() =>
      json(429, { error: { code: "rate_limited", message: "rate limit exceeded" } }, { "Retry-After": "2" }),
    );
    const client = createDataClient({ apiKey: API_KEY, fetch });

    const { error, response } = await client.GET("/{chain}/status/freshness", {
      params: { path: { chain: CHAIN } },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(isDataApiError(error)).toBe(true);
    if (isDataApiError(error)) expect(error.error.code).toBe("rate_limited");
  });

  it("types chain-scoped paths with the {chain} segment exactly as the spec defines it", () => {
    expectTypeOf<"/chains">().toExtend<keyof paths>();
    expectTypeOf<"/{chain}/blocks/{number}">().toExtend<keyof paths>();
    expectTypeOf<"/blocks/{number}">().not.toExtend<keyof paths>();
    expectTypeOf<NonNullable<paths["/{chain}/blocks/{number}"]["get"]["parameters"]["path"]>>().toEqualTypeOf<{
      chain: string;
      number: number;
    }>();
  });
});

describe("isDataApiError", () => {
  it.each([
    ["minimal", { error: { code: "not_found", message: "x" } }],
    ["indexed_through number", { error: { code: "not_indexed_yet", message: "x", indexed_through: 0 } }],
    ["data object", { error: { code: "unavailable", message: "x", data: { reason: null } } }],
  ])("accepts %s", (_l, v) => {
    expect(isDataApiError(v)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty string", ""],
    ["HTML string", "<html>502</html>"],
    ["JSON string", '{"error":{"code":"a","message":"b"}}'],
    ["array", []],
    ["no error key", {}],
    ["error null", { error: null }],
    ["error array", { error: [] }],
    ["error string", { error: "boom" }],
    ["non-string code", { error: { code: 401, message: "x" } }],
    ["non-string message", { error: { code: "a", message: null } }],
    ["missing message", { error: { code: "a" } }],
    ["indexed_through string", { error: { code: "a", message: "b", indexed_through: "5" } }],
    ["indexed_through null", { error: { code: "a", message: "b", indexed_through: null } }],
    ["data null", { error: { code: "a", message: "b", data: null } }],
    ["data array", { error: { code: "a", message: "b", data: [] } }],
    ["data string", { error: { code: "a", message: "b", data: "x" } }],
  ])("rejects %s", (_l, v) => {
    expect(isDataApiError(v)).toBe(false);
  });
});

describe("DEFAULT_BASE_URL", () => {
  it("is the public production Data API URL", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.blockvectra.com/v1/data");
  });
});
