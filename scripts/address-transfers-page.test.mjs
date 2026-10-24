import test, { after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPage } from "../examples/address-transfers-page.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = path.join(
  REPO_ROOT,
  ".tmp",
  "address-transfers-page-tests",
  `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
);
const CHAIN = "robinhood_mainnet";
const ADDRESS = `0x${"12".repeat(20)}`;
const OTHER_ADDRESS = `0x${"34".repeat(20)}`;
const API_KEY = "rgw_test_key_not_for_logs";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

await fs.mkdir(TEST_ROOT, { recursive: true, mode: 0o700 });
after(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

async function withCase(fn) {
  const dir = await fs.mkdtemp(path.join(TEST_ROOT, "case-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function baseEnv(dir, overrides = {}) {
  return {
    BLOCKVECTRA_API_KEY: API_KEY,
    BLOCKVECTRA_CHAIN: CHAIN,
    BLOCKVECTRA_ADDRESS: ADDRESS,
    BLOCKVECTRA_FROM_BLOCK: "100",
    BLOCKVECTRA_TO_BLOCK: "200",
    BLOCKVECTRA_STATE: path.join(dir, "state.json"),
    ...overrides,
  };
}

function transferRow(index = 0, extra = {}) {
  return {
    token: `0x${"cd".repeat(20)}`,
    standard: "erc20",
    from: ADDRESS,
    to: OTHER_ADDRESS,
    amount: (10n ** 30n + BigInt(index)).toString(),
    block_number: 150,
    block_timestamp: "2026-10-24T00:00:00Z",
    tx_hash: `0x${"ef".repeat(32)}`,
    tx_index: index,
    log_index: index,
    ...extra,
  };
}

function envelope(options = {}) {
  const body = {
    data: options.rows ?? [transferRow()],
    meta: {
      chain: options.chain ?? CHAIN,
      chain_slug: "ROBINHOOD_MAINNET",
      chain_external_id: "eip155:4663",
      as_of_block: options.asOfBlock ?? 200,
      safe_block: 190,
      finalized_block: 180,
      coverage: options.coverage ?? "full",
      refreshed_at: "2026-10-24T00:00:00Z",
      custom_marker: "preserve-this-meta",
      ...(options.meta ?? {}),
    },
  };
  if (Object.prototype.hasOwnProperty.call(options, "cursor")) {
    body.next_cursor = options.cursor;
  }
  return body;
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function recordingFetch(handler) {
  const calls = [];
  const fetch = async (request) => {
    calls.push(request);
    return handler(request, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

function queryFor(env) {
  return {
    chain: env.BLOCKVECTRA_CHAIN,
    address: env.BLOCKVECTRA_ADDRESS,
    from_block: env.BLOCKVECTRA_FROM_BLOCK,
    to_block: env.BLOCKVECTRA_TO_BLOCK,
    standard: "erc20",
    direction: "any",
    limit: 100,
  };
}

function stateFor(env, pages, overrides = {}) {
  return {
    version: 1,
    query: queryFor(env),
    pages,
    ...overrides,
  };
}

async function writeState(statePath, data, mode = 0o600) {
  await fs.writeFile(statePath, typeof data === "string" ? data : JSON.stringify(data), {
    mode,
  });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function assertNoFetch(fetch) {
  assert.equal(fetch.calls.length, 0);
}

function useShortTimeout(ms) {
  const original = AbortSignal.timeout;
  const calls = [];
  AbortSignal.timeout = function timeout(requested) {
    calls.push(requested);
    return original.call(this, ms);
  };
  return {
    calls,
    restore() {
      AbortSignal.timeout = original;
    },
  };
}

async function expectRejectWithin(promise, timeoutMs = 3000) {
  let timer;
  const watchdog = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("test watchdog expired");
      error.code = "TEST_WATCHDOG";
      reject(error);
    }, timeoutMs);
  });
  try {
    await assert.rejects(Promise.race([promise, watchdog]), (error) => {
      assert.notEqual(error && error.code, "TEST_WATCHDOG");
      return true;
    });
  } finally {
    clearTimeout(timer);
  }
}

test("one page per run: first, empty page with cursor, exhausted page, then zero GET", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const firstCursor = "page-1 +/=?&% \t\n";
    const secondCursor = "page-2; opaque [ok]";
    const first = envelope({ rows: [transferRow(1), transferRow(2)], cursor: firstCursor });
    const second = envelope({ rows: [], cursor: secondCursor });
    const third = envelope({ rows: [] });

    const originalTimeout = AbortSignal.timeout;
    const timeoutCalls = [];
    AbortSignal.timeout = function timeout(ms) {
      timeoutCalls.push(ms);
      return originalTimeout.call(this, ms);
    };

    let summary1;
    try {
      const fetch = recordingFetch(async (request) => {
        const lockPath = `${env.BLOCKVECTRA_STATE}.lock`;
        await fs.access(lockPath);
        assert.equal((await fs.stat(lockPath)).mode & 0o777, 0o600);
        assert.ok(request instanceof Request);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.get("x-api-key"), API_KEY);
        assert.equal(request.headers.has("blockvectraqa"), false);
        const headerText = [...request.headers]
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n");
        assert.equal(headerText.includes("BlockVectraQA"), false);
        assert.ok(request.signal instanceof AbortSignal);

        const url = new URL(request.url);
        assert.equal(
          url.pathname,
          `/v1/data/${CHAIN}/addresses/${ADDRESS}/transfers`,
        );
        assert.equal(url.searchParams.get("standard"), "erc20");
        assert.equal(url.searchParams.get("direction"), "any");
        assert.equal(url.searchParams.get("from_block"), "100");
        assert.equal(url.searchParams.get("to_block"), "200");
        assert.equal(url.searchParams.get("limit"), "100");
        assert.equal(url.searchParams.has("clamp"), false);
        assert.equal(url.searchParams.has("cursor"), false);
        return jsonResponse(first);
      });

      summary1 = await runPage({ env, fetch });
      assert.equal(fetch.calls.length, 1);
      assert.equal(timeoutCalls.length, 1);
      assert.equal(timeoutCalls[0], 15_000);
    } finally {
      AbortSignal.timeout = originalTimeout;
    }

    assert.deepEqual(summary1, {
      rows: 2,
      pages: 1,
      pagination_exhausted: false,
      observed_coverages: ["full"],
    });

    const statePath = env.BLOCKVECTRA_STATE;
    const saved1 = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(saved1, {
      version: 1,
      query: {
        chain: CHAIN,
        address: ADDRESS,
        from_block: "100",
        to_block: "200",
        standard: "erc20",
        direction: "any",
        limit: 100,
      },
      pages: [first],
    });
    assert.equal(first.meta.custom_marker, "preserve-this-meta");
    assert.equal(typeof first.data[0].amount, "string");
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600);
    assert.equal(await exists(`${statePath}.lock`), false);

    const fetch2 = recordingFetch(async (request) => {
      assert.equal(new URL(request.url).searchParams.get("cursor"), firstCursor);
      return jsonResponse(second);
    });
    const summary2 = await runPage({ env, fetch: fetch2 });
    assert.equal(fetch2.calls.length, 1);
    assert.deepEqual(summary2, {
      rows: 2,
      pages: 2,
      pagination_exhausted: false,
      observed_coverages: ["full"],
    });
    const saved2 = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(saved2.pages, [first, second]);

    const fetch3 = recordingFetch(async (request) => {
      assert.equal(new URL(request.url).searchParams.get("cursor"), secondCursor);
      return jsonResponse(third);
    });
    const summary3 = await runPage({ env, fetch: fetch3 });
    assert.equal(fetch3.calls.length, 1);
    assert.deepEqual(summary3, {
      rows: 2,
      pages: 3,
      pagination_exhausted: true,
      observed_coverages: ["full"],
    });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).pages, [
      first,
      second,
      third,
    ]);

    const fetch4 = recordingFetch(async () => {
      throw new Error("complete state must not fetch");
    });
    const summary4 = await runPage({ env, fetch: fetch4 });
    await assertNoFetch(fetch4);
    assert.deepEqual(summary4, summary3);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")).pages, [
      first,
      second,
      third,
    ]);
  });
});

test("invalid inputs and mismatched saved queries fail before any request", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const saved = stateFor(env, [envelope({ cursor: "saved-cursor" })]);
    await writeState(env.BLOCKVECTRA_STATE, saved);
    const before = await fs.readFile(env.BLOCKVECTRA_STATE);

    const mismatches = [
      { BLOCKVECTRA_CHAIN: "other_mainnet" },
      { BLOCKVECTRA_ADDRESS: OTHER_ADDRESS },
      { BLOCKVECTRA_FROM_BLOCK: "101" },
      { BLOCKVECTRA_TO_BLOCK: "201" },
    ];
    for (const overrides of mismatches) {
      const fetch = recordingFetch(async () => jsonResponse(envelope({})));
      await assert.rejects(runPage({ env: baseEnv(dir, overrides), fetch }));
      await assertNoFetch(fetch);
      assert.deepEqual(await fs.readFile(env.BLOCKVECTRA_STATE), before);
    }

    const invalid = [
      { BLOCKVECTRA_API_KEY: "" },
      { BLOCKVECTRA_API_KEY: "   " },
      { BLOCKVECTRA_CHAIN: "Robinhood_Mainnet" },
      { BLOCKVECTRA_CHAIN: "robinhood-mainnet" },
      { BLOCKVECTRA_ADDRESS: "0x1234" },
      { BLOCKVECTRA_ADDRESS: `0x${"12".repeat(19)}` },
      { BLOCKVECTRA_FROM_BLOCK: "-1" },
      { BLOCKVECTRA_FROM_BLOCK: "1.5" },
      { BLOCKVECTRA_FROM_BLOCK: "01" },
      { BLOCKVECTRA_FROM_BLOCK: "9007199254740992" },
      { BLOCKVECTRA_TO_BLOCK: "99" },
      { BLOCKVECTRA_FROM_BLOCK: "0", BLOCKVECTRA_TO_BLOCK: "100000" },
      { BLOCKVECTRA_STATE: "" },
      { BLOCKVECTRA_STATE: "bad\0path" },
      { BLOCKVECTRA_STATE: path.join(dir, "missing", "state.json") },
    ];
    for (const overrides of invalid) {
      const fetch = recordingFetch(async () => jsonResponse(envelope({})));
      await assert.rejects(runPage({ env: baseEnv(dir, overrides), fetch }));
      await assertNoFetch(fetch);
      assert.deepEqual(await fs.readFile(env.BLOCKVECTRA_STATE), before);
    }
  });
});

test("HTTP error statuses do not log or persist a reflected key", async () => {
  for (const status of [400, 401, 409, 422, 429, 503]) {
    await withCase(async (dir) => {
      const env = baseEnv(dir);
      const reflectedKey = `${API_KEY}-${status}`;
      const logs = [];
      const originalLog = console.log;
      const originalError = console.error;
      console.log = (...args) => logs.push(args);
      console.error = (...args) => logs.push(args);

      let error;
      try {
        const fetch = recordingFetch(async () =>
          jsonResponse(
            {
              error: {
                code: "reflected_error",
                message: reflectedKey,
              },
              reflected_key: reflectedKey,
            },
            status,
            { "x-reflected-key": reflectedKey },
          ),
        );
        try {
          await runPage({ env, fetch });
        } catch (caught) {
          error = caught;
        }
        assert.equal(fetch.calls.length, 1);
      } finally {
        console.log = originalLog;
        console.error = originalError;
      }

      assert.ok(error);
      assert.deepEqual(logs, []);
      assert.equal(String(error && error.stack).includes(reflectedKey), false);
      assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
      assert.deepEqual(await fs.readdir(dir), []);
    });
  }
});

test("a server error preserves the checkpoint and resumes from the same cursor", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    await writeState(statePath, stateFor(env, [envelope({ cursor: "before-error" })]));
    const before = await fs.readFile(statePath);

    const failed = recordingFetch(async () =>
      jsonResponse(
        { error: { code: "unavailable", message: `${API_KEY} must not persist` } },
        503,
      ),
    );
    await assert.rejects(runPage({ env, fetch: failed }));
    assert.equal(failed.calls.length, 1);
    assert.deepEqual(await fs.readFile(statePath), before);

    const resumed = recordingFetch(async (request) => {
      assert.equal(new URL(request.url).searchParams.get("cursor"), "before-error");
      return jsonResponse(envelope({ rows: [], cursor: undefined }));
    });
    const summary = await runPage({ env, fetch: resumed });
    assert.equal(resumed.calls.length, 1);
    assert.deepEqual(summary, {
      rows: 1,
      pages: 2,
      pagination_exhausted: true,
      observed_coverages: ["full"],
    });
  });
});

test("a timeout rejects once, does not retry, and leaves no checkpoint", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const fetch = recordingFetch(async () => {
      throw new DOMException("the operation timed out", "TimeoutError");
    });
    let error;
    try {
      await runPage({ env, fetch });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(fetch.calls.length, 1);
    assert.equal(String(error && error.stack).includes("timed out"), false);
    assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
    assert.equal(await exists(`${env.BLOCKVECTRA_STATE}.lock`), false);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("the deadline covers a delayed body even when fetch ignores the signal", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    await writeState(
      statePath,
      stateFor(env, [envelope({ rows: [transferRow(0)], cursor: "before-timeout" })]),
    );
    const before = await fs.readFile(statePath);
    const encoder = new TextEncoder();
    let cancelCalled = false;

    const stream = new ReadableStream({
      start(controller) {
        setTimeout(() => {
          try {
            controller.enqueue(
              encoder.encode(JSON.stringify(envelope({ cursor: "late-cursor" }))),
            );
            controller.close();
          } catch {
            // The reader may already be cancelled by the deadline.
          }
        }, 100);
      },
      cancel() {
        cancelCalled = true;
        return new Promise(() => {});
      },
    });
    const fetch = recordingFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const clock = useShortTimeout(20);
    try {
      await expectRejectWithin(runPage({ env, fetch }));
    } finally {
      clock.restore();
    }
    assert.deepEqual(clock.calls, [15_000]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(cancelCalled, true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.equal(await exists(`${statePath}.lock`), false);
    assert.deepEqual(await fs.readdir(dir), ["state.json"]);
  });
});

test("a forever-pending body rejects at the deadline without awaiting cancellation", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    let cancelCalled = false;
    const stream = new ReadableStream({
      start() {},
      cancel() {
        cancelCalled = true;
        return new Promise(() => {});
      },
    });
    const fetch = recordingFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const clock = useShortTimeout(20);
    try {
      await expectRejectWithin(runPage({ env, fetch }));
    } finally {
      clock.restore();
    }
    assert.deepEqual(clock.calls, [15_000]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(cancelCalled, true);
    assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
    assert.equal(await exists(`${env.BLOCKVECTRA_STATE}.lock`), false);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("a fetch that ignores the signal and never settles cannot hold the run open", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const fetch = recordingFetch(() => new Promise(() => {}));

    const clock = useShortTimeout(20);
    try {
      await expectRejectWithin(runPage({ env, fetch }));
    } finally {
      clock.restore();
    }
    assert.deepEqual(clock.calls, [15_000]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
    assert.equal(await exists(`${env.BLOCKVECTRA_STATE}.lock`), false);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("invalid JSON and malformed response envelopes never advance the checkpoint", async () => {
  const variants = [
    [
      "invalid JSON",
      () =>
        new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ],
    ["wrong chain", () => jsonResponse(envelope({ chain: "other_mainnet", cursor: "c" }))],
    ["bad coverage", () => jsonResponse(envelope({ coverage: "complete", cursor: "c" }))],
    ["as_of_block below window", () => jsonResponse(envelope({ asOfBlock: 199, cursor: "c" }))],
    [
      "meta is null",
      () => {
        const body = envelope({ cursor: "c" });
        body.meta = null;
        return jsonResponse(body);
      },
    ],
    [
      "data is not an array",
      () => {
        const body = envelope({ cursor: "c" });
        body.data = {};
        return jsonResponse(body);
      },
    ],
    ["row is not an object", () => jsonResponse(envelope({ rows: [null], cursor: "c" }))],
    [
      "too many rows",
      () =>
        jsonResponse(
          envelope({
            rows: Array.from({ length: 101 }, (_, index) => transferRow(index)),
            cursor: "c",
          }),
        ),
    ],
    ["cursor null", () => jsonResponse(envelope({ cursor: null }))],
    ["cursor empty", () => jsonResponse(envelope({ cursor: "" }))],
    ["cursor number", () => jsonResponse(envelope({ cursor: 7 }))],
  ];

  for (const [name, makeResponse] of variants) {
    await withCase(async (dir) => {
      const env = baseEnv(dir);
      const fetch = recordingFetch(async () => makeResponse());
      await assert.rejects(runPage({ env, fetch }));
      assert.equal(fetch.calls.length, 1);
      assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
      assert.deepEqual(await fs.readdir(dir), []);
    });
  }
});

test("a duplicate cursor in a new response fails without advancing", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    const state = stateFor(env, [
      envelope({ cursor: "c1" }),
      envelope({ cursor: "c2" }),
    ]);
    await writeState(statePath, state);
    const before = await fs.readFile(statePath);

    const fetch = recordingFetch(async () => jsonResponse(envelope({ cursor: "c1" })));
    await assert.rejects(runPage({ env, fetch }));
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.equal(await exists(`${statePath}.lock`), false);
  });
});

test("saved state corruption, invalid pages, budgets, and cycles fail before network", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    const goodPage = envelope({ cursor: "c0" });
    const manyPages = Array.from({ length: 21 }, (_, index) =>
      envelope({ cursor: `c${index}` }),
    );

    const cases = [
      ["corrupt JSON", "{not json"],
      ["unknown version", stateFor(env, [goodPage], { version: 2 })],
      ["version wrong type", stateFor(env, [goodPage], { version: "1" })],
      ["empty pages", stateFor(env, [])],
      ["more than twenty pages", stateFor(env, manyPages)],
      [
        "finished page followed by another",
        stateFor(env, [envelope({}), envelope({ cursor: "later" })]),
      ],
      [
        "duplicate saved cursors",
        stateFor(env, [envelope({ cursor: "same" }), envelope({ cursor: "same" })]),
      ],
      ["saved cursor null", stateFor(env, [envelope({ cursor: null })])],
      ["saved cursor empty", stateFor(env, [envelope({ cursor: "" })])],
      ["saved cursor number", stateFor(env, [envelope({ cursor: 2 })])],
      [
        "saved wrong chain",
        stateFor(env, [envelope({ chain: "other_mainnet", cursor: "c" })]),
      ],
      [
        "saved bad coverage",
        stateFor(env, [envelope({ coverage: "mostly-full", cursor: "c" })]),
      ],
      [
        "saved as_of_block below window",
        stateFor(env, [envelope({ asOfBlock: 199, cursor: "c" })]),
      ],
      ["saved data not array", stateFor(env, [{ ...goodPage, data: null }])],
      ["saved row not object", stateFor(env, [{ ...goodPage, data: [1] }])],
      ["saved too many rows", stateFor(env, [envelope({ rows: Array.from({ length: 101 }, (_, index) => transferRow(index)), cursor: "c" })])],
      [
        "saved query mismatch",
        stateFor(env, [goodPage], {
          query: { ...queryFor(env), address: OTHER_ADDRESS },
        }),
      ],
      ["extra top-level key", stateFor(env, [goodPage], { extra: true })],
    ];

    for (const [name, state] of cases) {
      await writeState(statePath, state);
      const before = await fs.readFile(statePath);
      const fetch = recordingFetch(async () => jsonResponse(envelope({})));
      await assert.rejects(runPage({ env, fetch }));
      assert.equal(fetch.calls.length, 0);
      assert.deepEqual(await fs.readFile(statePath), before);
      assert.deepEqual(await fs.readdir(dir), ["state.json"]);
    }
  });
});

test("existing JSON null, false, 0, and [] checkpoints fail before network", async () => {
  // Only JSON null was observed in the first review; false, 0, and [] were
  // already rejected by the saved-state shape check.
  for (const raw of ["null", "false", "0", "[]"]) {
    await withCase(async (dir) => {
      const env = baseEnv(dir);
      const statePath = env.BLOCKVECTRA_STATE;
      await fs.writeFile(statePath, raw, { mode: 0o600 });
      const before = await fs.readFile(statePath);

      const fetch = recordingFetch(async () => jsonResponse(envelope({})));
      await assert.rejects(runPage({ env, fetch }));
      assert.equal(fetch.calls.length, 0);
      assert.deepEqual(await fs.readFile(statePath), before);
      assert.equal(await exists(`${statePath}.lock`), false);
      assert.deepEqual(await fs.readdir(dir), ["state.json"]);
    });
  }
});

test("oversize, symlink, and non-regular checkpoints are rejected without mutation", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;

    await fs.writeFile(statePath, Buffer.alloc(MAX_STATE_BYTES + 1, 0x20), { mode: 0o600 });
    const oversize = await fs.readFile(statePath);
    let fetch = recordingFetch(async () => jsonResponse(envelope({})));
    await assert.rejects(runPage({ env, fetch }));
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(await fs.readFile(statePath), oversize);
    assert.equal(await exists(`${statePath}.lock`), false);

    await fs.rm(statePath);
    const target = path.join(dir, "target.json");
    const valid = stateFor(env, [envelope({ cursor: "target-cursor" })]);
    await writeState(target, valid);
    await fs.symlink("target.json", statePath);
    const targetBefore = await fs.readFile(target);
    fetch = recordingFetch(async () => jsonResponse(envelope({})));
    await assert.rejects(runPage({ env, fetch }));
    assert.equal(fetch.calls.length, 0);
    assert.equal((await fs.lstat(statePath)).isSymbolicLink(), true);
    assert.deepEqual(await fs.readFile(target), targetBefore);

    await fs.unlink(statePath);
    await fs.rm(target);
    await fs.mkdir(statePath);
    fetch = recordingFetch(async () => jsonResponse(envelope({})));
    await assert.rejects(runPage({ env, fetch }));
    assert.equal(fetch.calls.length, 0);
    assert.equal((await fs.lstat(statePath)).isDirectory(), true);
    assert.equal(await exists(`${statePath}.lock`), false);
  });
});

test("an existing lock is never removed or stolen based on age or contents", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const lockPath = `${env.BLOCKVECTRA_STATE}.lock`;
    await fs.writeFile(lockPath, "owned by another process\n", { mode: 0o640 });
    await fs.chmod(lockPath, 0o640);
    const before = await fs.readFile(lockPath);
    const beforeMode = (await fs.stat(lockPath)).mode & 0o777;

    const fetch = recordingFetch(async () => jsonResponse(envelope({})));
    await assert.rejects(runPage({ env, fetch }), /lock exists/i);
    assert.equal(fetch.calls.length, 0);
    assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
    assert.deepEqual(await fs.readFile(lockPath), before);
    assert.equal((await fs.stat(lockPath)).mode & 0o777, beforeMode);
  });
});

test("twenty saved pages with a cursor stop before network; exhausted twenty return zero GET", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    const budgetPages = Array.from({ length: 20 }, (_, index) =>
      envelope({ rows: [], cursor: `budget-${index}` }),
    );
    await writeState(statePath, stateFor(env, budgetPages));
    const before = await fs.readFile(statePath);

    let fetch = recordingFetch(async () => jsonResponse(envelope({})));
    await assert.rejects(runPage({ env, fetch }), /page budget/i);
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(await fs.readFile(statePath), before);

    const exhaustedPages = Array.from({ length: 20 }, (_, index) =>
      index === 19 ? envelope({ rows: [], coverage: "partial" }) : envelope({ rows: [], cursor: `done-${index}` }),
    );
    await writeState(statePath, stateFor(env, exhaustedPages));
    fetch = recordingFetch(async () => jsonResponse(envelope({})));
    const summary = await runPage({ env, fetch });
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(summary, {
      rows: 0,
      pages: 20,
      pagination_exhausted: true,
      observed_coverages: ["full", "partial"],
    });
  });
});

test("a streamed body over 1 MiB is cancelled without JSON parsing or state", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        for (let index = 0; index < 17; index += 1) {
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
        }
      },
      cancel() {
        cancelled = true;
        return new Promise(() => {});
      },
    });
    const fetch = recordingFetch(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await expectRejectWithin(runPage({ env, fetch }));
    assert.equal(fetch.calls.length, 1);
    assert.equal(cancelled, true);
    assert.equal(await exists(env.BLOCKVECTRA_STATE), false);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

test("checkpoint growth over 2 MiB fails before write and preserves old bytes", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    const big = envelope({
      rows: [transferRow(0, { padding: "x".repeat(1_800_000) })],
      cursor: "big-cursor",
    });
    await writeState(statePath, stateFor(env, [big]));
    const initialStat = await fs.stat(statePath);
    assert.ok(initialStat.size < MAX_STATE_BYTES);
    const before = await fs.readFile(statePath);

    const next = envelope({
      rows: [transferRow(1, { padding: "y".repeat(300_000) })],
    });
    const fetch = recordingFetch(async () => jsonResponse(next));
    await assert.rejects(runPage({ env, fetch }), /checkpoint/i);
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.deepEqual(await fs.readdir(dir), ["state.json"]);
  });
});

test("an injected rename failure preserves the old checkpoint and the next run resumes", async () => {
  await withCase(async (dir) => {
    const env = baseEnv(dir);
    const statePath = env.BLOCKVECTRA_STATE;
    await writeState(statePath, stateFor(env, [envelope({ cursor: "rename-cursor" })]));
    const before = await fs.readFile(statePath);

    const failed = recordingFetch(async () => jsonResponse(envelope({ rows: [] })));
    await assert.rejects(
      runPage({
        env,
        fetch: failed,
        rename: async () => {
          throw new Error("injected rename failure");
        },
      }),
      /checkpoint/i,
    );
    assert.equal(failed.calls.length, 1);
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.deepEqual(await fs.readdir(dir), ["state.json"]);

    const resumed = recordingFetch(async (request) => {
      assert.equal(new URL(request.url).searchParams.get("cursor"), "rename-cursor");
      return jsonResponse(envelope({ rows: [] }));
    });
    const summary = await runPage({ env, fetch: resumed });
    assert.equal(resumed.calls.length, 1);
    assert.deepEqual(summary, {
      rows: 1,
      pages: 2,
      pagination_exhausted: true,
      observed_coverages: ["full"],
    });
  });
});
