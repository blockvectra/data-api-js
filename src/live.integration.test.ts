/**
 * Live smoke test against the public Data API. Runs only when
 * BLOCKVECTRA_API_KEY is set (skipped in CI and on machines without a key);
 * makes a single cheap GET. The key is never logged.
 */
import { describe, expect, it } from "vitest";

import { createDataClient } from "./index.js";

const apiKey = process.env.BLOCKVECTRA_API_KEY;

describe.skipIf(!apiKey)("live Data API (BLOCKVECTRA_API_KEY)", () => {
  it("GET /{chain}/status/freshness against the default base URL", async () => {
    const client = createDataClient({ apiKey: apiKey ?? "" });

    const { data, error, response } = await client.GET("/{chain}/status/freshness", {
      params: { path: { chain: "robinhood_mainnet" } },
    });

    expect(response.status, `unexpected HTTP ${response.status} (error: ${JSON.stringify(error)})`).toBe(200);
    expect(data?.meta.chain).toBe("robinhood_mainnet");
    expect(data?.meta.finalized_block).toBeGreaterThan(0);
    expect(data?.data.length).toBeGreaterThan(0);
  }, 30_000);
});
