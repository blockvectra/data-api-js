# @blockvectra/data-api

TypeScript client for the [BlockVectra Data API](https://docs.blockvectra.com/en/api/data/?ref=gh-data-api-js).

- **Documentation**: [https://docs.blockvectra.com/en/api/data/](https://docs.blockvectra.com/en/api/data/?ref=gh-data-api-js)
- **Get an API Key**: [https://blockvectra.com/en/get-api-key/](https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js)
- **Status**: Version 0.x. Interfaces may evolve as new endpoints and features are added.

One client works for every supported chain via the `{chain}` path parameter, giving read-only REST/JSON access to indexed chain data (blocks, transactions, addresses, tokens, NFTs, DEX activity, tokenized stocks, dataset freshness).

- Request paths, parameters and response bodies are typed from the Data API's OpenAPI document.
- Runtime is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) (~6 kB): one `fetch` per call, no retries, no caching, no hidden pagination.
- ESM only. Works wherever `fetch` exists (Node.js 18+, Deno, Bun, edge runtimes). Keep your API key secret — call the API from a backend, not from client-side browser code.

## Installation

This package is not yet published to npm. A prebuilt package is available from the [v0.1.3 GitHub release](https://github.com/blockvectra/data-api-js/releases/tag/v0.1.3); you can also install it directly from source via GitHub or build it locally.

### Install the prebuilt package

```bash
npm install https://github.com/blockvectra/data-api-js/releases/download/v0.1.3/blockvectra-data-api-0.1.3.tgz
```

The tarball includes compiled code and TypeScript declarations, so installation does not generate the schema or compile from source. The [release](https://github.com/blockvectra/data-api-js/releases/tag/v0.1.3) also provides a `SHA256SUMS` file for verification.

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

The Git install runs the package's `prepare` script, which generates the TypeScript types from the Data API's public OpenAPI document and then builds `dist/`. The install therefore needs network access to `https://docs.blockvectra.com/openapi/data.yaml`.

If you have the OpenAPI document saved locally — useful for an offline build or to build against a frozen schema — point `BLOCKVECTRA_OPENAPI_FILE` at its absolute path:

```bash
BLOCKVECTRA_OPENAPI_FILE=/path/to/data.yaml npm install github:blockvectra/data-api-js
```

This only changes where the schema is read from; npm still downloads dependencies according to your npm configuration.

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

Save this as `quickstart.mjs` in a project where the package is installed (see [Installation](#installation)). It makes exactly one `GET /{chain}/status/freshness` request with a 15-second timeout and no retries.

```js
import { createDataClient, isDataApiError } from "@blockvectra/data-api";

const chain = process.env.BLOCKVECTRA_CHAIN || "robinhood_mainnet";
// A missing or blank key throws a TypeError here, before any request is sent.
const client = createDataClient({ apiKey: process.env.BLOCKVECTRA_API_KEY });

const { data, error, response } = await client.GET("/{chain}/status/freshness", {
  params: { path: { chain } },
  signal: AbortSignal.timeout(15_000),
});

if (!response.ok) {
  const code = isDataApiError(error) && /^[a-z0-9_]{1,64}$/.test(error.error.code) ? ` ${error.error.code}` : "";
  throw new Error(`Data API request failed: HTTP ${response.status}${code}`);
}
if (!data) {
  throw new Error(`Data API returned HTTP ${response.status} without data`);
}

console.log("chain:", chain);
console.log("as_of_block:", data.meta.as_of_block);
console.log("finalized_block:", data.meta.finalized_block);
console.log("datasets:", data.data.length);
```

Provide the key through your environment or a secret manager (`BLOCKVECTRA_API_KEY`), then run `node quickstart.mjs`. Do not paste the key on the command line or into the file, and do not print it. Set `BLOCKVECTRA_CHAIN` to use another [supported chain](https://docs.blockvectra.com/en/chains/?ref=gh-data-api-js).

Any non-2xx response, or a `200` without data, makes the script exit with an error. For a `401`, check the key and the chain. For `429` and `503`, see [Error Handling](#error-handling) and retry on your own schedule; the example does not retry.

## Create a Client

Get an API key from [https://blockvectra.com/en/get-api-key/](https://blockvectra.com/en/get-api-key/?ref=gh-data-api-js) (or the console at [https://console.blockvectra.com/keys/](https://console.blockvectra.com/keys/?ref=gh-data-api-js)).

```ts
import { createDataClient } from "@blockvectra/data-api";

const client = createDataClient({ apiKey: process.env.BLOCKVECTRA_API_KEY! });
const chain = "robinhood_mainnet";
```

The key is sent in the `x-api-key` header on every request. Options:

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | *(required)* | Your BlockVectra API key. Sent in `x-api-key`. Must be a non-empty string; otherwise `createDataClient` throws a `TypeError` locally and sends no request. |
| `baseUrl` | `https://api.blockvectra.com/v1/data` | Exported as `DEFAULT_BASE_URL`; override it to target another endpoint. |
| `fetch` | `globalThis.fetch` | Custom `fetch` function (for proxies, custom headers, mocks, or instrumentation). |

If `process.env.BLOCKVECTRA_API_KEY` is unset, empty or only whitespace, `createDataClient` throws a `TypeError` before any request is made. The SDK does not check the key's format or whether it is active; a non-empty key is sent unchanged and the server decides. To read the variable explicitly without printing it:

```ts
import { createDataClient } from "@blockvectra/data-api";

const apiKey = process.env.BLOCKVECTRA_API_KEY;
if (!apiKey) {
  throw new Error("Set BLOCKVECTRA_API_KEY to your BlockVectra API key.");
}
const client = createDataClient({ apiKey });
```

Every endpoint except `GET /chains` requires `{chain}`. Use a `chain` value returned by the Data API's `GET /chains` (for example, `robinhood_mainnet`) and check that entry's `features` and `coverage` for the dataset you need. See the [Data API chain reference](https://docs.blockvectra.com/en/api/data/?ref=gh-data-api-js#chains).

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
    console.log(row.dataset, row.max_block_number, row.blocks_behind);
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
  console.log(block.hash, block.timestamp, block.tx_count);
}
```

### A Transaction, with Its Event Logs

```ts
import { isDataApiError } from "@blockvectra/data-api";

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
  console.error(response.status, isDataApiError(error) ? error.error.code : undefined);
}
```

`value` and other amounts that can exceed 2^53 are decimal strings, never JSON numbers — parse them with `BigInt(tx.value)`.

### ERC-20 Transfers for an Address

Address listings need a block window (`from_block`/`to_block`, at most 100,000 blocks) and are cursor-paginated. Pass `next_cursor` back unchanged until it is absent:

```ts
import { isDataApiError } from "@blockvectra/data-api";

const address = "0xc2038401dc39805d25427591b43714cdf1e02c64";
let cursor: string | undefined;

do {
  const { data, error, response } = await client.GET("/{chain}/addresses/{address}/transfers", {
    params: {
      path: { chain, address },
      query: { standard: "erc20", from_block: head - 99_999, to_block: head, limit: 100, cursor },
    },
  });
  if (!data) throw new Error(`transfers: HTTP ${response.status} ${isDataApiError(error) ? error.error.code : ""}`);

  for (const t of data.data) {
    if (t.standard === "erc20") console.log(t.block_number, t.token, t.from, t.to, t.amount);
  }
  cursor = data.next_cursor;
} while (cursor);
```

`head` is `meta.as_of_block` from the freshness endpoint. With `clamp: "true"`, a window that is too wide or whose `to_block` is past `as_of_block` is truncated instead of failing with `409` (unless `from_block` itself is past it), and `meta.coverage` becomes `"partial"`.

## Error Handling

The client does not throw on HTTP errors — check `response.ok` / `response.status`. (A network failure still rejects, as `fetch` does.) Errors returned by the API use the JSON envelope `{ "error": { "code": "...", "message": "...", "indexed_through"?: number } }` (exported as the `DataApiError` type, the shape of a *verified* JSON body): an HTTP error payload is not always JSON, so narrow it with the exported `isDataApiError(error)` guard before reading `error.error.code`. It only checks the structure; it does not validate your key. Branch on `code`, and treat `message` as text for logs. `indexed_through` is present only on `409 not_indexed_yet` (the highest indexed block). Responses that are not API JSON — a CDN or server 5xx HTML page, for example — have no `error.code`. Non-JSON error bodies may be returned as raw text; an empty response may have no `error` value. Use `response.status` for both. Authentication uses only the `x-api-key` header: a missing key returns HTTP `401` with `error.code` `missing_api_key`, while an unknown, disabled, or revoked key returns HTTP `401` with `error.code` `invalid_api_key`. An unknown or not-public chain returns HTTP `404` with `error.code` `not_found` before the API key lookup and is not billed; do not treat an empty `404` body as an authentication error. See authentication errors for [`missing_api_key`](https://docs.blockvectra.com/en/errors/#missing_api_key) and [`invalid_api_key`](https://docs.blockvectra.com/en/errors/#invalid_api_key).

```ts
import { isDataApiError } from "@blockvectra/data-api";

const { data, error, response } = await client.GET("/{chain}/blocks/{number}", {
  params: { path: { chain, number: 72838701 } },
});

if (!response.ok) {
  const apiError = isDataApiError(error) ? error.error : undefined; // only when the API returned a JSON error body
  const code = apiError?.code;
  const retryAfter = response.headers.get("Retry-After"); // seconds, when present

  if (response.status === 401) {
    const reason = code === "missing_api_key" ? "API key missing"
      : code === "invalid_api_key" ? "API key invalid (unknown, disabled, or revoked)"
      : "authentication failed";
    throw new Error(`Data API: ${reason}`);
  }
  if (response.status === 429 || response.status === 503) {
    // back off for `retryAfter` seconds (or your own delay) and retry
  }
  throw new Error(`Data API ${response.status} ${code}: ${apiError?.message}`);
}
```

| Status | `error.code` | Meaning | What to do |
| --- | --- | --- | --- |
| `401` | `missing_api_key` | No API key was sent in `x-api-key` | Send an API key in `x-api-key` |
| `401` | `invalid_api_key` | The API key is unknown, disabled, or revoked | Use an active, valid key |
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
