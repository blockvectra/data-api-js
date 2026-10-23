import createClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { components, paths } from "./schema.js";

export type { components, operations, paths } from "./schema.js";

/**
 * Public Data API base URL — the same value the BlockVectra docs use
 * (`NEXT_PUBLIC_DATA_API_URL`). Every route except `/chains` continues with
 * the chain identifier, e.g. `${DEFAULT_BASE_URL}/robinhood_mainnet/blocks/1`.
 * Override it with `createDataClient({ baseUrl })`.
 */
export const DEFAULT_BASE_URL = "https://api.blockvectra.com/v1/data";

export interface DataClientOptions {
  /** Your BlockVectra API key (`rgw_…`). Sent as the `x-api-key` header on every request. */
  apiKey: string;
  /** API base URL. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Custom `fetch` (tests, proxies, instrumentation). Called with a `Request`; defaults to `globalThis.fetch`. */
  fetch?: ClientOptions["fetch"];
}

/** Typed client: `GET`/`POST` take the spec's path templates, e.g. `client.GET("/{chain}/blocks/{number}", …)`. */
export type DataClient = Client<paths>;

/**
 * Body of every JSON error response: `{ error: { code, message } }`, plus an
 * optional `indexed_through` (the highest indexed block) only on
 * `409 not_indexed_yet`. Branch on `code`; `message` is for logs.
 */
export type DataApiError = components["schemas"]["ErrorBody"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows an HTTP error payload to {@link DataApiError}. Error payloads are not
 * guaranteed to be JSON (HTML pages, empty bodies, raw text), so check before
 * reading `error.code`. Only the shape is checked; nothing is parsed or coerced.
 */
export function isDataApiError(value: unknown): value is DataApiError {
  if (!isPlainObject(value) || !isPlainObject(value.error)) return false;
  const { code, message, indexed_through, data } = value.error;
  return (
    typeof code === "string" &&
    typeof message === "string" &&
    (indexed_through === undefined || typeof indexed_through === "number") &&
    (data === undefined || isPlainObject(data))
  );
}

/** Creates a typed Data API client that authenticates every request with `apiKey`. */
export function createDataClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetch }: DataClientOptions): DataClient {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new TypeError(
      "createDataClient: `apiKey` must be a non-empty string. If you read it from an environment variable such as BLOCKVECTRA_API_KEY, check that the variable is set and not empty.",
    );
  }
  return createClient<paths>({ baseUrl, fetch, headers: { "x-api-key": apiKey } });
}
