import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDataClient } from "@blockvectra/data-api";

const API_PATH = "/{chain}/addresses/{address}/transfers";
const PAGE_LIMIT = 100;
const MAX_PAGES = 20;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MISSING_STATE = Symbol("missing checkpoint");
const REQUEST_FAILED = "The Data API request failed.";
const QUERY_KEYS = ["chain", "address", "from_block", "to_block", "standard", "direction", "limit"];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasCursor(envelope) {
  return Object.prototype.hasOwnProperty.call(envelope, "next_cursor");
}

function readNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function parseBlock(value, name) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(`${name} must be a non-negative decimal integer string.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    fail(`${name} must be a safe integer.`);
  }
  return { text: value, number };
}

function readInputs(env, fetchImpl, renameImpl) {
  if (!isPlainObject(env)) fail("The environment is not available.");
  if (typeof fetchImpl !== "function") fail("A fetch function is required.");
  if (typeof renameImpl !== "function") fail("A rename function is required.");

  const apiKey = env.BLOCKVECTRA_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    fail("BLOCKVECTRA_API_KEY is required.");
  }

  const chain = env.BLOCKVECTRA_CHAIN;
  if (typeof chain !== "string" || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(chain)) {
    fail("BLOCKVECTRA_CHAIN must be a lowercase chain slug.");
  }

  const address = env.BLOCKVECTRA_ADDRESS;
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    fail("BLOCKVECTRA_ADDRESS must be a 0x-prefixed 20-byte address.");
  }

  const from = parseBlock(env.BLOCKVECTRA_FROM_BLOCK, "BLOCKVECTRA_FROM_BLOCK");
  const to = parseBlock(env.BLOCKVECTRA_TO_BLOCK, "BLOCKVECTRA_TO_BLOCK");
  if (to.number < from.number) {
    fail("BLOCKVECTRA_TO_BLOCK must be greater than or equal to BLOCKVECTRA_FROM_BLOCK.");
  }
  if (to.number - from.number > 99_999) {
    fail("The block window must contain at most 100,000 blocks.");
  }

  const statePath = env.BLOCKVECTRA_STATE;
  if (typeof statePath !== "string" || statePath.length === 0 || statePath.includes("\0")) {
    fail("BLOCKVECTRA_STATE must be an explicit checkpoint path.");
  }

  const query = {
    chain,
    address,
    from_block: from.text,
    to_block: to.text,
    standard: "erc20",
    direction: "any",
    limit: PAGE_LIMIT,
  };

  return {
    apiKey,
    query,
    fromBlock: from.number,
    toBlock: to.number,
    statePath: path.resolve(statePath),
  };
}

function validateEnvelope(envelope, query) {
  if (!isPlainObject(envelope)) fail("The saved or returned page is not an envelope.");
  if (!Array.isArray(envelope.data)) fail("The page data is not an array.");
  if (envelope.data.length > PAGE_LIMIT) fail("The page contains too many rows.");
  for (const row of envelope.data) {
    if (!isPlainObject(row)) fail("A page row is not an object.");
  }

  if (!isPlainObject(envelope.meta)) fail("The page meta is not an object.");
  if (envelope.meta.chain !== query.chain) fail("The page chain does not match the checkpoint query.");
  if (envelope.meta.coverage !== "full" && envelope.meta.coverage !== "partial") {
    fail("The page coverage is not full or partial.");
  }
  if (
    !Number.isSafeInteger(envelope.meta.as_of_block) ||
    envelope.meta.as_of_block < Number(query.to_block)
  ) {
    fail("The page as_of_block is not a safe integer at or above the window.");
  }

  let cursor;
  if (hasCursor(envelope)) {
    cursor = envelope.next_cursor;
    if (!readNonEmptyString(cursor)) fail("The page next_cursor is not a non-empty string.");
  }
  return cursor;
}

function validateSavedState(state, query) {
  if (!hasExactKeys(state, ["version", "query", "pages"])) fail("The checkpoint shape is invalid.");
  if (state.version !== 1) fail("The checkpoint version is unsupported.");
  if (!hasExactKeys(state.query, QUERY_KEYS)) fail("The checkpoint query shape is invalid.");
  for (const key of QUERY_KEYS) {
    if (state.query[key] !== query[key]) fail("The checkpoint query does not match the requested query.");
  }
  if (!Array.isArray(state.pages) || state.pages.length === 0 || state.pages.length > MAX_PAGES) {
    fail("The checkpoint pages are invalid.");
  }

  const cursors = new Set();
  let finished = false;
  for (const page of state.pages) {
    if (finished) fail("A finished page is followed by another page.");
    const cursor = validateEnvelope(page, query);
    if (cursor !== undefined) {
      if (cursors.has(cursor)) fail("The checkpoint contains a duplicate cursor.");
      cursors.add(cursor);
    } else {
      finished = true;
    }
  }

  return { cursors, finished };
}

async function ensureParentDirectory(statePath) {
  let info;
  try {
    info = await fs.stat(path.dirname(statePath));
  } catch {
    fail("The checkpoint parent directory does not exist.");
  }
  if (!info.isDirectory()) fail("The checkpoint parent is not a directory.");
}

async function readCheckpoint(statePath) {
  let info;
  try {
    info = await fs.lstat(statePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return MISSING_STATE;
    fail("The checkpoint could not be inspected.");
  }

  if (info.isSymbolicLink() || !info.isFile()) {
    fail("The checkpoint must be a regular file, not a symlink or special file.");
  }
  if (info.size > MAX_STATE_BYTES) fail("The checkpoint exceeds the example size limit.");

  let handle;
  try {
    handle = await fs.open(statePath, "r");
  } catch {
    fail("The checkpoint could not be opened.");
  }

  try {
    const opened = await handle.stat();
    if (!opened.isFile()) fail("The checkpoint is not a regular file.");
    if (opened.size > MAX_STATE_BYTES) fail("The checkpoint exceeds the example size limit.");

    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_STATE_BYTES) fail("The checkpoint exceeds the example size limit.");

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, total));
    } catch {
      fail("The checkpoint is not valid UTF-8.");
    }

    try {
      return JSON.parse(text);
    } catch {
      fail("The checkpoint is not valid JSON.");
    }
  } finally {
    try {
      await handle.close();
    } catch {
      // A close failure must not replace the checkpoint validation result.
    }
  }
}

function cancelBestEffort(cancel) {
  try {
    const pending = cancel();
    if (pending && typeof pending.then === "function") {
      pending.catch(() => {});
    }
  } catch {
    // Cancellation is best effort and must never mask the real result.
  }
}

function cancelResponseBody(response) {
  if (response && response.body && typeof response.body.cancel === "function") {
    cancelBestEffort(() => response.body.cancel());
  }
}

function cancelReader(reader) {
  cancelBestEffort(() => reader.cancel());
}

function raceWithSignal(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(new Error(REQUEST_FAILED));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      Promise.resolve(promise).catch(() => {});
      reject(new Error(REQUEST_FAILED));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createBoundedFetch(fetchImpl, signal) {
  return async function boundedFetch(request) {
    let response;
    try {
      const pending = Promise.resolve()
        .then(() => fetchImpl(request))
        .then((value) => {
          if (signal.aborted) {
            cancelResponseBody(value);
            throw new Error(REQUEST_FAILED);
          }
          return value;
        });
      response = await raceWithSignal(pending, signal);
    } catch {
      fail(REQUEST_FAILED);
    }
    if (!(response instanceof Response)) fail("The Data API returned an invalid fetch response.");
    if (signal.aborted) {
      cancelResponseBody(response);
      fail(REQUEST_FAILED);
    }

    if (response.body === null) {
      const status = response.status;
      return new Response(status === 204 || status === 205 || status === 304 ? null : "", {
        status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let overLimit = false;
    for (;;) {
      let chunk;
      try {
        chunk = await raceWithSignal(reader.read(), signal);
      } catch {
        cancelReader(reader);
        fail(REQUEST_FAILED);
      }
      if (chunk.done) break;
      if (!chunk.value) continue;
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        overLimit = true;
        cancelReader(reader);
        break;
      }
      chunks.push(chunk.value);
    }

    if (overLimit) fail("The Data API response exceeds the example size limit.");

    const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
    const status = response.status;
    return new Response(status === 204 || status === 205 || status === 304 ? null : body, {
      status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function requestPage({ apiKey, query, fromBlock, toBlock, cursor, fetchImpl }) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const client = createDataClient({
    apiKey,
    fetch: createBoundedFetch(fetchImpl, signal),
  });

  const requestQuery = {
    standard: "erc20",
    direction: "any",
    from_block: fromBlock,
    to_block: toBlock,
    limit: PAGE_LIMIT,
  };
  if (cursor !== undefined) requestQuery.cursor = cursor;

  let result;
  try {
    result = await raceWithSignal(
      client.GET(API_PATH, {
        params: {
          path: { chain: query.chain, address: query.address },
          query: requestQuery,
        },
        signal,
      }),
      signal,
    );
  } catch {
    fail(REQUEST_FAILED);
  }

  if (!result || !result.response || !result.response.ok) {
    fail("The Data API returned an unsuccessful response.");
  }
  if (signal.aborted) fail(REQUEST_FAILED);
  return { data: result.data, signal };
}

async function writeCheckpoint(statePath, state, renameImpl) {
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    fail("The checkpoint would exceed the example size limit.");
  }

  const directory = path.dirname(statePath);
  const base = path.basename(statePath);
  let tempPath;
  let handle;
  try {
    for (let attempt = 0; attempt < 10 && !handle; attempt += 1) {
      const candidate = path.join(
        directory,
        `.${base}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
      );
      try {
        handle = await fs.open(candidate, "wx", 0o600);
        tempPath = candidate;
      } catch (error) {
        if (!error || error.code !== "EEXIST") fail("The checkpoint temp file could not be created.");
      }
    }
    if (!handle) fail("The checkpoint temp file could not be created.");

    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await renameImpl(tempPath, statePath);
      tempPath = null;
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Cleanup must not mask the write failure.
        }
      }
      if (tempPath) {
        try {
          await fs.unlink(tempPath);
        } catch {
          // Cleanup must not mask the write failure.
        }
      }
    }
  } catch {
    fail("The checkpoint could not be written.");
  }
}

function summarize(pages) {
  let rows = 0;
  const coverages = [];
  for (const page of pages) {
    rows += page.data.length;
    if (!coverages.includes(page.meta.coverage)) coverages.push(page.meta.coverage);
  }
  return {
    rows,
    pages: pages.length,
    pagination_exhausted: !hasCursor(pages[pages.length - 1]),
    observed_coverages: coverages,
  };
}

/**
 * Advances an address-transfers checkpoint by at most one explicit page.
 *
 * The caller supplies the SDK fetch implementation. The checkpoint lock is
 * taken before the saved state is read and before the one request is made.
 */
export async function runPage({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  rename: renameImpl = fs.rename,
} = {}) {
  const { apiKey, query, fromBlock, toBlock, statePath } = readInputs(env, fetchImpl, renameImpl);
  const lockPath = `${statePath}.lock`;

  await ensureParentDirectory(statePath);

  let lockHandle;
  try {
    lockHandle = await fs.open(lockPath, "wx", 0o600);
  } catch {
    fail("The checkpoint lock exists or could not be created; inspect it before manual removal.");
  }

  try {
    const saved = await readCheckpoint(statePath);
    let state;
    let cursors;
    let finished;

    if (saved === MISSING_STATE) {
      state = { version: 1, query: { ...query }, pages: [] };
      cursors = new Set();
      finished = false;
    } else {
      const checked = validateSavedState(saved, query);
      state = saved;
      cursors = checked.cursors;
      finished = checked.finished;
    }

    if (finished) return summarize(state.pages);
    if (state.pages.length >= MAX_PAGES) {
      fail("The checkpoint reached the example page budget; start a new checkpoint after review.");
    }

    const lastPage = state.pages.length > 0 ? state.pages[state.pages.length - 1] : undefined;
    const previousCursor = lastPage && hasCursor(lastPage) ? lastPage.next_cursor : undefined;
    const { data, signal } = await requestPage({
      apiKey,
      query,
      fromBlock,
      toBlock,
      cursor: previousCursor,
      fetchImpl,
    });
    const nextCursor = validateEnvelope(data, query);
    if (nextCursor !== undefined && cursors.has(nextCursor)) {
      fail("The Data API returned a duplicate cursor; the checkpoint was not advanced.");
    }
    if (signal.aborted) fail(REQUEST_FAILED);

    state.pages.push(data);
    await writeCheckpoint(statePath, state, renameImpl);
    return summarize(state.pages);
  } finally {
    if (lockHandle) {
      try {
        await lockHandle.close();
      } catch {
        // Lock cleanup must not mask the operation result.
      }
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // Lock cleanup must not mask the operation result.
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const summary = await runPage();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch {
    process.stderr.write("address-transfers-page: failed; the checkpoint was not advanced\n");
    process.exitCode = 1;
  }
}
