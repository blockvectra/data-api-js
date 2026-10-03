import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { createDataClient, DEFAULT_BASE_URL, type DataApiError, type paths } from "./index.js";

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

    expectTypeOf(error).toEqualTypeOf<DataApiError | undefined>();
    expect(data).toBeUndefined();
    expect(response.status).toBe(404);
    expect(error?.error.code).toBe("not_found");
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
    expect(error?.error.code).toBe("rate_limited");
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

describe("DEFAULT_BASE_URL", () => {
  it("is the public production Data API URL", () => {
    expect(DEFAULT_BASE_URL).toBe("https://api.blockvectra.com/v1/data");
  });
});
