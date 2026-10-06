# @blockvectra/data-api

TypeScript client for the [BlockVectra Data API](https://docs.blockvectra.com/en/?ref=gh-data-api-js).

- **Documentation**: [https://docs.blockvectra.com/en/?ref=gh-data-api-js](https://docs.blockvectra.com/en/?ref=gh-data-api-js)
- **Get an API Key**: [https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js](https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js)
- **Status**: Version 0.x. Interfaces may evolve as new endpoints and features are added.

One client works for every supported chain via the `{chain}` path parameter, giving read-only REST/JSON access to indexed chain data (blocks, transactions, addresses, tokens, NFTs, DEX activity, tokenized stocks, dataset freshness).

- Request paths, parameters and response bodies are typed from the Data API's OpenAPI document.
- Runtime is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) (~6 kB): one `fetch` per call, no retries, no caching, no hidden pagination.
- ESM only. Works wherever `fetch` exists (Node.js 18+, Deno, Bun, edge runtimes). Keep your API key secret — call the API from a backend, not from client-side browser code.

## Installation

This package is not yet published to npm. You can install it directly from source via GitHub or build it locally.

### Install from GitHub

```bash
npm install github:blockvectra/data-api-js
```

Or with `pnpm` / `yarn`:

```bash
pnpm add github:blockvectra/data-api-js
# or
yarn add github:blockvectra/data-api-js
```

### Install from Local Source

```bash
git clone https://github.com/blockvectra/data-api-js.git
cd data-api-js
npm install
npm run build
```

Then in your project:

```bash
npm install /path/to/data-api-js
```

### Once Published to npm

```bash
npm install @blockvectra/data-api
```

## Quick Start

```ts
import { createDataClient } from "@blockvectra/data-api";

const client = createDataClient({ apiKey: process.env.BLOCKVECTRA_API_KEY! });
const chain = "robinhood_mainnet";

const { data, error } = await client.GET("/{chain}/status/freshness", {
  params: { path: { chain } },
});

if (data) {
  console.log("Finalized block:", data.meta.finalized_block);
}
```

## Create a Client

Get an API key from [https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js](https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js) (or the console at [https://console.blockvectra.com/keys/?ref=gh-data-api-js](https://console.blockvectra.com/keys/?ref=gh-data-api-js)).

```ts
import { createDataClient } from "@blockvectra/data-api";

const client = createDataClient({ apiKey: process.env.BLOCKVECTRA_API_KEY! });
const chain = "robinhood_mainnet";
```

The key is sent in the `x-api-key` header on every request. Options:

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | *(required)* | Your BlockVectra API key. Sent in `x-api-key`. |
| `baseUrl` | `https://api.blockvectra.com/v1/data` | Exported as `DEFAULT_BASE_URL`; override it to target another endpoint. |
| `fetch` | `globalThis.fetch` | Custom `fetch` function (for proxies, custom headers, mocks, or instrumentation). |

Every endpoint except `GET /chains` requires `{chain}`. Use any slug from [Supported Chains](https://docs.blockvectra.com/en/chains/?ref=gh-data-api-js) (`robinhood_mainnet`, `hyperevm_testnet`, etc.). `GET /chains` returns all publicly listed chains.

## Examples

### Freshness & Head Blocks

Every chain-scoped response returns `meta.as_of_block` (the newest block fully written to the index) and `meta.finalized_block` (the reorg-safe block).

```ts
const { data, error, response } = await client.GET("/{chain}/status/freshness", {
  params: { path: { chain } },
});

if (data) {
  console.log(data.meta.as_of_block);     // newest indexed block height
  console.log(data.meta.finalized_block); // reorg-safe block height
  for (const row of data.data) {
    console.log(row.table, row.latest_block, row.lag_blocks);
  }
}
```

### Blocks and Block Details

```ts
const { data, error } = await client.GET("/{chain}/blocks/{number}", {
  params: { path: { chain, number: 72838701 } },
});

if (data) {
  const block = data.data;
  console.log(block.hash, block.timestamp, block.transaction_count);
}
```

### A Transaction, with Its Event Logs

```ts
const { data, error, response } = await client.GET("/{chain}/transactions/{hash}", {
  params: {
    path: { chain, hash: "0xc6045ba4d19b790f2d8ac100ecb3ac6c4da87364732fbd079a19dfbfc3485669" },
    query: { include_logs: "true" },
  },
});

if (data) {
  const tx = data.data;
  console.log(tx.block_number, tx.from, tx.to, tx.value, tx.status, tx.logs?.length);
} else {
  console.error(response.status, error?.error?.code);
}
```

`value` and other amounts that can exceed 2^53 are decimal strings, never JSON numbers — parse them with `BigInt(tx.value)`.

### ERC-20 Transfers for an Address

Address listings need a block window (`from_block`/`to_block`, at most 100,000 blocks) and are cursor-paginated. Pass `next_cursor` back unchanged until it is absent:

```ts
const address = "0xc2038401dc39805d25427591b43714cdf1e02c64";
let cursor: string | undefined;

do {
  const { data, error, response } = await client.GET("/{chain}/addresses/{address}/transfers", {
    params: {
      path: { chain, address },
      query: { standard: "erc20", from_block: head - 99_999, to_block: head, limit: 100, cursor },
    },
  });
  if (!data) throw new Error(`transfers: HTTP ${response.status} ${error?.error?.code ?? ""}`);

  for (const t of data.data) {
    if (t.standard === "erc20") console.log(t.block_number, t.token, t.from, t.to, t.amount);
  }
  cursor = data.next_cursor;
} while (cursor);
```

`head` is `meta.as_of_block` from the freshness endpoint. With `clamp: "true"`, a window that is too wide or whose `to_block` is past `as_of_block` is truncated instead of failing with `409` (unless `from_block` itself is past it), and `meta.coverage` becomes `"partial"`.

## Error Handling

The client does not throw on HTTP errors — check `response.ok` / `response.status`. (A network failure still rejects, as `fetch` does.) Only errors produced by the API itself have a JSON error body, `{ "error": { "code": "...", "message": "...", "indexed_through"?: number } }` (exported as the `DataApiError` type): branch on `code`, and treat `message` as text for logs. `indexed_through` is present only on `409 not_indexed_yet` (the highest indexed block). For anything else — a CDN or server 5xx HTML page, for example — `error` is the raw string, so rely on `response.status` instead. One API error has no body at all: a missing, unknown, or disabled API key gets `404` with an **empty body**, so `error` is `undefined` there. In contrast, an unknown or not-public chain returns HTTP `404` with `error.code` `not_found` (decided before the key check, not billed).

```ts
const { data, error, response } = await client.GET("/{chain}/blocks/{number}", {
  params: { path: { chain, number: 72838701 } },
});

if (!response.ok) {
  const code = error?.error?.code; // undefined when the body is empty or not JSON
  const retryAfter = response.headers.get("Retry-After"); // seconds, when present

  if (response.status === 404 && !code) throw new Error("API key missing, unknown or disabled");
  if (response.status === 429 || response.status === 503) {
    // back off for `retryAfter` seconds (or your own delay) and retry
  }
  throw new Error(`Data API ${response.status} ${code}: ${error?.error?.message}`);
}
```

| Status | `error.code` | Meaning | What to do |
| --- | --- | --- | --- |
| `404` | — (empty body) | Missing, unknown, or disabled API key (the reason is not distinguished) | Pass an active, valid key |
| `404` | `not_found` | The object doesn't exist (or isn't indexed yet), or `{chain}` is an unknown or not-public chain (HTTP `404` with `error.code` `not_found`, not billed) | Check the request |
| `409` | `not_indexed_yet` | Block number or window is above the newest fully written block (`as_of_block`), or hash resolves above it; `indexed_through` is the highest indexed block | Poll/retry later until your block is at or below `indexed_through` |
| `429` | `rate_limited` | Requests sent too quickly | Retry later; honour `Retry-After` when present |
| `429` | `cost_exceeds_burst` | A single request costs more than your burst capacity | Make the request smaller (retrying as-is never succeeds) |
| `503` | `unavailable` (also `billing_unavailable`) | Temporarily unavailable | Retry later; honour `Retry-After` when present |

Other statuses use the same body: `400 bad_request` (invalid parameter or cursor), `402 insufficient_balance` (top up in the console), `409 window_too_large`, `422 no_coverage`. The [API reference](https://docs.blockvectra.com/en/api/data/?ref=gh-data-api-js) lists the exact codes for each endpoint. Requests are metered in Compute Units (CU), and only 2xx responses are billed.

## Types

The generated OpenAPI types are re-exported for your own code:

```ts
import type { components, DataClient, DataApiError } from "@blockvectra/data-api";

type Block = components["schemas"]["Block"];
```

## Development

```bash
npm install
npm run build     # generates schema from public OpenAPI spec and compiles
npm run typecheck # verifies TypeScript types
npm test          # runs unit tests
```

Unit tests use a mocked `fetch`. A live smoke test (`GET /{chain}/status/freshness`) runs when `BLOCKVECTRA_API_KEY` is set in the environment and is skipped otherwise.

## License

[MIT](LICENSE)
