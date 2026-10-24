import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInstallArgs,
  parseArgs,
  runCli,
  verifyPublication,
} from "./verify-publication.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SLOT_ROOT = path.resolve(SCRIPT_DIR, "..");
const TEST_TMP_ROOT = path.join(SLOT_ROOT, ".tmp");

const PACKAGE_NAME = "@blockvectra/data-api";
const VERSION = "0.1.4";
const SOURCE = "8ee835c34d9561050344cc385777ef5c9e5dfd16";
const TREE = "0123456789abcdef0123456789abcdef01234567";
const REGISTRY = "https://registry.npmjs.org/";
const METADATA_URL = `${REGISTRY}${PACKAGE_NAME}`;
const TARBALL_URL = `${REGISTRY}${PACKAGE_NAME}/-/data-api-${VERSION}.tgz`;

const INDEX_JS = `export const DEFAULT_BASE_URL = "https://api.invalid/v1/data";

export function isDataApiError(value) {
  return Boolean(value && value.error);
}

export function createDataClient(options) {
  if (typeof options?.apiKey !== "string" || options.apiKey.trim() === "") {
    throw new TypeError("createDataClient: apiKey must be a non-empty string");
  }
  return { options };
}
`;

const README = "# @blockvectra/data-api fixture\n\nThe frozen archive README.\n";
const LICENSE = "MIT\n";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Base64(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else await fs.copyFile(from, to);
  }
}

async function makeWorkspace({ packageJsonOverrides = {}, filesOverrides = {} } = {}) {
  await fs.mkdir(TEST_TMP_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEST_TMP_ROOT, "verify-publication-test-"));
  const fixtureRoot = path.join(root, "fixture");
  const templateDir = path.join(fixtureRoot, "package");
  const packageJson = {
    name: PACKAGE_NAME,
    version: VERSION,
    type: "module",
    main: "./dist/index.js",
    module: "./dist/index.js",
    exports: { ".": { import: "./dist/index.js" } },
    ...packageJsonOverrides,
  };
  const packageJsonText = `${JSON.stringify(packageJson, null, 2)}\n`;
  const files = {
    "package.json": packageJsonText,
    "README.md": README,
    "LICENSE": LICENSE,
    "dist/index.js": INDEX_JS,
    ...filesOverrides,
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(templateDir, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }

  const archivePath = path.join(root, `blockvectra-data-api-${VERSION}.tgz`);
  execFileSync("tar", ["-czf", archivePath, "package"], { cwd: fixtureRoot });
  const archiveBytes = await fs.readFile(archivePath);

  return {
    root,
    templateDir,
    files,
    archivePath,
    archiveBytes,
    sha256: sha256(archiveBytes),
    integrity: `sha512-${sha512Base64(archiveBytes)}`,
  };
}

function makePackument(workspace, overrides = {}) {
  const document = {
    name: PACKAGE_NAME,
    "dist-tags": { latest: VERSION },
    readme: README,
    versions: {
      [VERSION]: {
        name: PACKAGE_NAME,
        version: VERSION,
        dist: {
          integrity: workspace.integrity,
          tarball: TARBALL_URL,
        },
      },
    },
  };
  return { ...document, ...overrides };
}

function responseFor(spec) {
  if (spec instanceof Error) throw spec;
  const status = spec.status ?? 200;
  if (spec.body === undefined) return new Response(null, { status });
  const body =
    typeof spec.body === "string" || Buffer.isBuffer(spec.body)
      ? spec.body
      : JSON.stringify(spec.body);
  return new Response(body, { status });
}

function hangingBodyResponse(status = 200, url = "") {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    text: () => new Promise(() => {}),
    arrayBuffer: () => new Promise(() => {}),
  };
}

function makeFetch(workspace, metadataResponses, { tarball = workspace.archiveBytes, tarballStatus = 200 } = {}) {
  const calls = [];
  let metadataIndex = 0;

  async function fetchImpl(url, init = {}) {
    calls.push({ url, init });
    if (url === METADATA_URL) {
      const spec = metadataResponses[Math.min(metadataIndex, metadataResponses.length - 1)];
      metadataIndex += 1;
      return responseFor(spec);
    }
    if (url === TARBALL_URL) {
      return responseFor({ status: tarballStatus, body: tarball });
    }
    throw new Error(`unexpected URL in offline test: ${url}`);
  }

  fetchImpl.calls = calls;
  fetchImpl.metadataIndex = () => metadataIndex;
  return fetchImpl;
}

function makeClock(start = Date.UTC(2025, 0, 1, 0, 0, 0)) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
    sleeps,
  };
}

function makeInstaller(workspace, { exitCode = 0, stdout = "npm install ok\n", stderr = "", mutate } = {}) {
  const calls = [];
  async function runInstall({ cwd, packageName, version, expectLatest }) {
    const packageSpec = expectLatest ? packageName : `${packageName}@${version}`;
    calls.push({ cwd, packageName, version, expectLatest, packageSpec });
    if (exitCode !== 0) {
      return {
        command: `npm install ${packageSpec}`,
        exitCode,
        signal: null,
        stdout,
        stderr,
      };
    }
    const destination = path.join(cwd, "node_modules", ...packageName.split("/"));
    await copyDirectory(workspace.templateDir, destination);
    if (mutate) await mutate(destination);
    return {
      command: `npm install ${packageSpec} --no-audit --no-fund`,
      exitCode: 0,
      signal: null,
      stdout,
      stderr,
    };
  }
  runInstall.calls = calls;
  return runInstall;
}

function makeOptions(workspace, overrides = {}) {
  return {
    package: PACKAGE_NAME,
    version: VERSION,
    archive: workspace.archivePath,
    sha256: workspace.sha256,
    source: SOURCE,
    tree: TREE,
    out: path.join(workspace.root, "out", "receipt.json"),
    expectLatest: false,
    ...overrides,
  };
}

function makeDeps({ workspace, fetchImpl, clock, installer, requestTimeoutMs }) {
  return {
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    runInstall: installer,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, "utf8"));
}

async function withWorkspace(t, options) {
  const workspace = await makeWorkspace(options);
  t.after(async () => {
    await fs.rm(workspace.root, { recursive: true, force: true });
  });
  return workspace;
}

test("test workspaces are unique directories under the slot .tmp", async (t) => {
  const first = await withWorkspace(t);
  const second = await withWorkspace(t);

  assert.equal(path.dirname(first.root), TEST_TMP_ROOT);
  assert.equal(path.dirname(second.root), TEST_TMP_ROOT);
  assert.notEqual(first.root, second.root);
});

test("404 then 200 keeps the first error and installs exactly once", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 404 }, { status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace);
  const options = makeOptions(workspace);

  const receipt = await verifyPublication(options, makeDeps({ workspace, fetchImpl, clock, installer }));

  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.phase, "complete");
  assert.equal(receipt.metadataAttemptCount, 2);
  assert.equal(receipt.metadataAttempts.length, 2);
  assert.equal(receipt.metadataAttempts[0].status, 404);
  assert.equal(receipt.metadata.firstError.code, "VERSION_NOT_VISIBLE");
  assert.equal(receipt.metadata.firstError.status, 404);
  assert.equal(installer.calls.length, 1);
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 1);
  for (const call of fetchImpl.calls) {
    assert.equal(call.init.headers?.authorization, undefined);
  }
  assert.equal(receipt.source, SOURCE);
  assert.equal(receipt.tree, TREE);
  assert.equal(receipt.archiveSha256Actual, workspace.sha256);
  assert.equal(receipt.install.attempts, 1);
  assert.equal(receipt.install.exitCode, 0);
  assert.equal(receipt.install.filesChecked, 4);
  assert.equal(await exists(installer.calls[0].cwd), false);
  assert.equal(await exists(receipt.install.stdoutPath), true);
  assert.equal(await exists(receipt.install.stderrPath), true);
});

test("200 with the target version missing waits, then succeeds", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const missing = makePackument(workspace);
  delete missing.versions[VERSION];
  const fetchImpl = makeFetch(workspace, [
    { status: 200, body: missing },
    { status: 200, body: makePackument(workspace) },
  ]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.metadataAttemptCount, 2);
  assert.equal(receipt.metadata.firstError.code, "VERSION_MISSING");
  assert.equal(receipt.metadata.firstError.status, 200);
  assert.deepEqual(clock.sleeps, [30_000]);
  assert.equal(installer.calls.length, 1);
});

test("timed-out processing never installs and exits non-zero", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 404 }]);
  const installer = makeInstaller(workspace);
  const options = makeOptions(workspace);
  const argv = [
    "--package",
    PACKAGE_NAME,
    "--version",
    VERSION,
    "--archive",
    workspace.archivePath,
    "--sha256",
    workspace.sha256,
    "--source",
    SOURCE,
    "--tree",
    TREE,
    "--out",
    options.out,
  ];

  const exitCode = await runCli(argv, makeDeps({ workspace, fetchImpl, clock, installer }));
  const receipt = await readJson(options.out);

  assert.equal(exitCode, 2);
  assert.equal(receipt.status, "PROCESSING_PENDING");
  assert.equal(receipt.error.code, "PROCESSING_PENDING");
  assert.equal(installer.calls.length, 0);
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 0);
  assert.equal(receipt.install.attempts, 0);
  assert.equal(receipt.metadataAttemptCount, 20);
  assert.deepEqual(clock.sleeps, Array(20).fill(30_000));
});

test("401 fails immediately without waiting or installing", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 401 }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.phase, "metadata");
  assert.equal(receipt.error.code, "METADATA_AUTH_ERROR");
  assert.equal(receipt.metadataAttemptCount, 1);
  assert.equal(clock.sleeps.length, 0);
  assert.equal(installer.calls.length, 0);
});

test("wrong dist-tag latest fails before downloading", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const document = makePackument(workspace, { "dist-tags": { latest: "9.9.9" } });
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: document }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace, { expectLatest: true }),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "LATEST_MISMATCH");
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 0);
  assert.equal(installer.calls.length, 0);
});

test("integrity mismatch fails before downloading", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const document = makePackument(workspace);
  document.versions[VERSION].dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: document }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "INTEGRITY_MISMATCH");
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 0);
  assert.equal(installer.calls.length, 0);
});

test("tarball bytes that do not match the archive fail after one download", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }], {
    tarball: Buffer.from("this is not the frozen archive"),
  });
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "TARBALL_SHA256_MISMATCH");
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 1);
  assert.equal(installer.calls.length, 0);
});

test("metadata headers followed by a hanging body time out and never install", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = async (url) => {
    if (url === METADATA_URL) return hangingBodyResponse();
    throw new Error(`unexpected URL: ${url}`);
  };
  const installer = makeInstaller(workspace);
  const started = Date.now();

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer, requestTimeoutMs: 30 }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "METADATA_TIMEOUT");
  assert.equal(receipt.metadataAttempts[0].outcome, "timeout");
  assert.equal(receipt.metadataAttempts[0].status, 200);
  assert.equal(receipt.metadataAttempts[0].timeoutMs, 30);
  assert.ok(Date.now() - started < 2000);
  assert.equal(installer.calls.length, 0);
});

test("tarball headers followed by a hanging body time out and never install", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === METADATA_URL) return responseFor({ status: 200, body: makePackument(workspace) });
    if (url === TARBALL_URL) return hangingBodyResponse();
    throw new Error(`unexpected URL: ${url}`);
  };
  const installer = makeInstaller(workspace);
  const started = Date.now();

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer, requestTimeoutMs: 30 }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "TARBALL_TIMEOUT");
  assert.equal(calls.filter((url) => url === TARBALL_URL).length, 1);
  assert.ok(Date.now() - started < 2000);
  assert.equal(installer.calls.length, 0);
});

test("metadata request near the 10-minute deadline is bounded by the remaining budget", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  let metadataCalls = 0;
  const fetchImpl = async (url) => {
    if (url !== METADATA_URL) throw new Error(`unexpected URL: ${url}`);
    metadataCalls += 1;
    if (metadataCalls === 1) {
      clock.advance(569_990);
      return responseFor({ status: 404 });
    }
    return hangingBodyResponse();
  };
  const installer = makeInstaller(workspace);
  const started = Date.now();

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer, requestTimeoutMs: 60_000 }),
  );

  assert.equal(metadataCalls, 2);
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "METADATA_TIMEOUT");
  assert.equal(receipt.metadataAttempts[1].timeoutMs, 10);
  assert.ok(Date.now() - started < 1000);
  assert.equal(installer.calls.length, 0);
});

test("broken public exports fail through a normal bare-name import", async (t) => {
  const workspace = await withWorkspace(t, {
    packageJsonOverrides: { exports: { ".": "./does-not-exist.js" } },
  });
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "INSTALLED_IMPORT_FAILED");
  assert.equal(receipt.install.esm.probe.exitCode, 1);
  assert.match(receipt.install.esm.probe.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.equal(installer.calls.length, 1);
});

test("missing required exports cannot PASS a bare-name import", async (t) => {
  const workspace = await withWorkspace(t, {
    filesOverrides: {
      "dist/index.js": `export const DEFAULT_BASE_URL = "https://api.invalid/v1/data";
export function isDataApiError(value) { return Boolean(value && value.error); }
`,
    },
  });
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "INSTALLED_EXPORTS_MISSING");
  assert.equal(receipt.install.esm.probe.exitCode, 11);
});

test("an installed package that accepts an empty key cannot PASS", async (t) => {
  const workspace = await withWorkspace(t, {
    filesOverrides: {
      "dist/index.js": `export const DEFAULT_BASE_URL = "https://api.invalid/v1/data";
export function isDataApiError() { return false; }
export function createDataClient() { return {}; }
`,
    },
  });
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "EMPTY_KEY_ACCEPTED");
  assert.equal(receipt.install.esm.probe.exitCode, 13);
});

test("latest mode asks the real installer for the bare package name", () => {
  const latest = buildInstallArgs({ packageName: PACKAGE_NAME, version: VERSION, expectLatest: true });
  const exact = buildInstallArgs({ packageName: PACKAGE_NAME, version: VERSION, expectLatest: false });
  assert.equal(latest[0], "install");
  assert.equal(latest[1], PACKAGE_NAME);
  assert.equal(exact[1], `${PACKAGE_NAME}@${VERSION}`);
  assert.ok(latest.includes("--no-audit"));
  assert.ok(latest.includes("--no-fund"));
  assert.ok(!latest.includes("--ignore-scripts"));
});

test("metadata README that differs from the archive README fails", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const document = makePackument(workspace, { readme: "# Different README\n" });
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: document }]);
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "README_MISMATCH");
  assert.equal(fetchImpl.calls.filter((call) => call.url === TARBALL_URL).length, 0);
  assert.equal(installer.calls.length, 0);
});

test("non-zero install exit cannot PASS and preserves output and cleanup", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace, {
    exitCode: 7,
    stdout: "npm stdout line\n",
    stderr: "npm stderr line\n",
  });

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.phase, "install");
  assert.equal(receipt.error.code, "INSTALL_FAILED");
  assert.equal(receipt.install.exitCode, 7);
  assert.equal(await fs.readFile(receipt.install.stdoutPath, "utf8"), "npm stdout line\n");
  assert.equal(await fs.readFile(receipt.install.stderrPath, "utf8"), "npm stderr line\n");
  assert.equal(await exists(installer.calls[0].cwd), false);
});

test("installed files that differ byte-for-byte cannot PASS", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace, {
    mutate: async (installedDir) => {
      await fs.writeFile(path.join(installedDir, "README.md"), "# tampered\n");
    },
  });

  const receipt = await verifyPublication(
    makeOptions(workspace),
    makeDeps({ workspace, fetchImpl, clock, installer }),
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.phase, "verify-install");
  assert.equal(receipt.error.code, "INSTALLED_FILE_MISMATCH");
  assert.match(receipt.error.message, /README\.md/);
  assert.equal(receipt.install.exitCode, 0);
  assert.equal(await exists(installer.calls[0].cwd), false);
});

test("full CLI success preserves source/tree, writes logs, and removes the consumer", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const fetchImpl = makeFetch(workspace, [{ status: 200, body: makePackument(workspace) }]);
  const installer = makeInstaller(workspace);
  const out = path.join(workspace.root, "out", "receipt.json");
  const argv = [
    "--package",
    PACKAGE_NAME,
    "--version",
    VERSION,
    "--archive",
    workspace.archivePath,
    "--sha256",
    workspace.sha256,
    "--source",
    SOURCE,
    "--tree",
    TREE,
    "--out",
    out,
    "--expect-latest",
  ];

  const exitCode = await runCli(argv, makeDeps({ workspace, fetchImpl, clock, installer }));
  const receipt = await readJson(out);

  assert.equal(exitCode, 0);
  assert.equal(receipt.status, "PASS");
  assert.equal(receipt.expectLatest, true);
  assert.equal(receipt.source, SOURCE);
  assert.equal(receipt.tree, TREE);
  assert.equal(receipt.archiveSha256, workspace.sha256);
  assert.equal(receipt.archiveSha256Actual, workspace.sha256);
  assert.equal(receipt.metadataAttemptCount, 1);
  assert.equal(receipt.install.esm.emptyKeyRejected, true);
  assert.equal(receipt.install.esm.probe.exitCode, 0);
  assert.equal(receipt.install.esm.entry, PACKAGE_NAME);
  assert.equal(installer.calls[0].expectLatest, true);
  assert.equal(installer.calls[0].packageSpec, PACKAGE_NAME);
  assert.deepEqual(receipt.install.esm.exports, [
    "createDataClient",
    "isDataApiError",
    "DEFAULT_BASE_URL",
  ]);
  assert.equal(await exists(installer.calls[0].cwd), false);
  assert.equal(await exists(`${out}.install.stdout.log`), true);
});

test("CLI rejects incomplete arguments before any network call", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  let fetched = false;
  const fetchImpl = async () => {
    fetched = true;
    throw new Error("must not fetch");
  };
  const out = path.join(workspace.root, "out", "receipt.json");
  const argv = [
    "--package",
    PACKAGE_NAME,
    "--version",
    VERSION,
    "--archive",
    workspace.archivePath,
    "--sha256",
    workspace.sha256,
    "--source",
    SOURCE,
    "--out",
    out,
  ];
  const exitCode = await runCli(argv, {
    fetch: fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    runInstall: makeInstaller(workspace),
  });
  const receipt = await readJson(out);

  assert.equal(exitCode, 2);
  assert.equal(fetched, false);
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.phase, "arguments");
  assert.equal(receipt.error.code, "INVALID_ARGUMENTS");
  assert.match(receipt.error.message, /--tree/);
});

test("CLI rejects a malformed sha256 before any network call", async (t) => {
  const workspace = await withWorkspace(t);
  const out = path.join(workspace.root, "out", "receipt.json");
  const argv = [
    "--package",
    PACKAGE_NAME,
    "--version",
    VERSION,
    "--archive",
    workspace.archivePath,
    "--sha256",
    "abc",
    "--source",
    SOURCE,
    "--tree",
    TREE,
    "--out",
    out,
  ];
  const exitCode = await runCli(argv, {
    fetch: () => {
      throw new Error("must not fetch");
    },
  });
  const receipt = await readJson(out);

  assert.equal(exitCode, 2);
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "INVALID_ARGUMENTS");
  assert.match(receipt.error.message, /64 hexadecimal/);
});

test("CLI without --out exits non-zero without writing a receipt", async () => {
  let fetched = false;
  const exitCode = await runCli(
    ["--package", PACKAGE_NAME, "--version", VERSION],
    {
      fetch: () => {
        fetched = true;
        throw new Error("must not fetch");
      },
    },
  );
  assert.equal(exitCode, 2);
  assert.equal(fetched, false);
});

test("parseArgs rejects unknown and repeated options", () => {
  const parsed = parseArgs([
    "--package",
    PACKAGE_NAME,
    "--package",
    PACKAGE_NAME,
    "--nope",
    "x",
    "--expect-latest",
    "--expect-latest",
  ]);
  assert.ok(parsed.errors.some((error) => error.includes("more than once")));
  assert.ok(parsed.errors.some((error) => error.includes("unknown option")));
});

test("archive SHA-256 mismatch fails before metadata", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const installer = makeInstaller(workspace);
  let fetched = false;

  const receipt = await verifyPublication(
    makeOptions(workspace, { sha256: "0".repeat(64) }),
    {
      fetch: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      now: clock.now,
      sleep: clock.sleep,
      runInstall: installer,
    },
  );

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "ARCHIVE_SHA256_MISMATCH");
  assert.equal(fetched, false);
  assert.equal(receipt.install.attempts, 0);
});

test("metadata fetch rejection is recorded as an immediate failure", async (t) => {
  const workspace = await withWorkspace(t);
  const clock = makeClock();
  const installer = makeInstaller(workspace);

  const receipt = await verifyPublication(makeOptions(workspace), {
    fetch: async () => {
      throw new Error("offline");
    },
    now: clock.now,
    sleep: clock.sleep,
    runInstall: installer,
  });

  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.error.code, "METADATA_FETCH_FAILED");
  assert.equal(receipt.metadataAttemptCount, 1);
  assert.equal(clock.sleeps.length, 0);
  assert.equal(installer.calls.length, 0);
});
