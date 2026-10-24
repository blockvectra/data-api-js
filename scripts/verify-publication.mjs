#!/usr/bin/env node
/**
 * Post-publication acceptance check for the public @blockvectra/data-api package.
 *
 * This is deliberately not a publisher: it never runs npm publish, never changes
 * the version, never retries an install, and never calls the business API. It
 * hashes the frozen release archive, polls public npm metadata, downloads the
 * published tarball once, and performs one isolated public npm install.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@blockvectra/data-api";
const REGISTRY = "https://registry.npmjs.org/";
const SHA256_RE = /^[a-f0-9]{64}$/i;
const METADATA_INTERVAL_MS = 30_000;
const METADATA_MAX_WAIT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const MAX_TAR_BUFFER = 128 * 1024 * 1024;
const REQUIRED_EXPORTS = ["createDataClient", "isDataApiError", "DEFAULT_BASE_URL"];
const REQUIRED_OPTIONS = ["package", "version", "archive", "sha256", "source", "tree", "out"];
const KNOWN_OPTIONS = new Set(REQUIRED_OPTIONS);

class VerificationError extends Error {
  constructor(code, message, { pending = false } = {}) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    this.pending = pending;
  }
}

function failure(code, message) {
  throw new VerificationError(code, message);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512Base64(bytes) {
  return createHash("sha512").update(bytes).digest("base64");
}

function utc(timestamp) {
  return new Date(timestamp).toISOString();
}

function makeBaseReceipt(values, expectLatest, startedAt) {
  return {
    tool: "verify-publication",
    package: values.package ?? null,
    version: values.version ?? null,
    archive: values.archive ?? null,
    archiveSha256: values.sha256 ?? null,
    archiveSha256Actual: null,
    source: values.source ?? null,
    tree: values.tree ?? null,
    expectLatest: Boolean(expectLatest),
    out: values.out ?? null,
    status: "RUNNING",
    phase: "arguments",
    startedAt: utc(startedAt),
    finishedAt: null,
    metadataAttemptCount: 0,
    metadataAttempts: [],
    metadata: {
      url: null,
      firstError: null,
      foundAt: null,
      firstErrorAt: null,
    },
    tarball: null,
    install: {
      attempts: 0,
      exitCode: null,
      signal: null,
      command: null,
      stdoutPath: null,
      stderrPath: null,
      filesChecked: null,
      esm: null,
    },
    error: null,
  };
}

/** Parses only the small, fixed CLI surface. Unknown or repeated flags are errors. */
export function parseArgs(argv) {
  const values = {};
  const errors = [];
  let expectLatest = false;
  let seenExpectLatest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--expect-latest") {
      if (seenExpectLatest) errors.push("--expect-latest was given more than once");
      seenExpectLatest = true;
      expectLatest = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      errors.push(`unexpected positional argument: ${arg}`);
      continue;
    }
    const name = arg.slice(2);
    if (!KNOWN_OPTIONS.has(name)) {
      errors.push(`unknown option: ${arg}`);
      continue;
    }
    if (Object.hasOwn(values, name)) {
      errors.push(`option given more than once: ${arg}`);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      errors.push(`option requires a value: ${arg}`);
      continue;
    }
    values[name] = value;
    i += 1;
  }

  return { values, expectLatest, errors };
}

function validateArguments(values, expectLatest) {
  const errors = [];
  for (const name of REQUIRED_OPTIONS) {
    if (typeof values[name] !== "string" || values[name].trim() === "") {
      errors.push(`missing required option: --${name}`);
    }
  }
  if (values.package !== undefined && values.package !== PACKAGE_NAME) {
    errors.push(`--package must be ${PACKAGE_NAME}`);
  }
  if (values.sha256 !== undefined && !SHA256_RE.test(values.sha256)) {
    errors.push("--sha256 must be exactly 64 hexadecimal characters");
  }
  if (errors.length > 0) return errors;
  return errors;
}

async function writeReceiptFile(out, receipt) {
  const target = path.resolve(out);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return target;
}

function execFileBuffer(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...options, encoding: "buffer" },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error
            ? typeof error.code === "number"
              ? error.code
              : null
            : 0,
          signal: error?.signal ?? null,
          spawnError: error && typeof error.code === "string" ? error.code : null,
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
        });
      },
    );
  });
}

async function runTar(args) {
  const result = await execFileBuffer("tar", args, { maxBuffer: MAX_TAR_BUFFER });
  if (result.spawnError || result.exitCode !== 0) {
    const detail = result.stderr.toString("utf8").trim();
    failure(
      "ARCHIVE_TAR_FAILED",
      `system tar failed (${result.spawnError ?? `exit ${result.exitCode}`})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function assertSafeArchiveName(name) {
  if (name === "" || /[\u0000-\u001f\\]/.test(name)) {
    failure("ARCHIVE_UNSAFE_PATH", `unsafe archive entry: ${JSON.stringify(name)}`);
  }
  if (name.startsWith("/")) {
    failure("ARCHIVE_UNSAFE_PATH", `absolute archive entry: ${JSON.stringify(name)}`);
  }
  if (!name.startsWith("package/")) {
    failure("ARCHIVE_UNEXPECTED_ROOT", `archive entry is outside package/: ${JSON.stringify(name)}`);
  }
  const segments = name.split("/");
  if (segments.includes(".") || segments.includes("..")) {
    failure("ARCHIVE_UNSAFE_PATH", `archive entry contains . or ..: ${JSON.stringify(name)}`);
  }
}

async function readArchive(archivePath) {
  const entries = [];

  // -t only lists, and -tv lets us reject symlinks/hardlinks/devices without
  // extracting anything to a directory.
  const verbose = (await runTar(["-tvzf", archivePath])).toString("utf8");
  for (const line of verbose.split(/\r?\n/)) {
    if (line === "") continue;
    const type = line[0];
    if (type !== "-" && type !== "d") {
      failure("ARCHIVE_ENTRY_TYPE_UNSUPPORTED", `archive entry is not a regular file or directory: ${line}`);
    }
  }

  const listing = (await runTar(["-tzf", archivePath])).toString("utf8");
  const names = listing.split(/\r?\n/).filter((name) => name !== "");
  if (names.length === 0) failure("ARCHIVE_EMPTY", "archive contains no entries");

  const seenFiles = new Set();
  for (const name of names) {
    assertSafeArchiveName(name);
    const isDirectory = name.endsWith("/");
    if (isDirectory) continue;
    if (name === "package/") continue;
    if (seenFiles.has(name)) {
      failure("ARCHIVE_DUPLICATE_FILE", `archive contains a duplicate file: ${name}`);
    }
    seenFiles.add(name);
    const relativePath = name.slice("package/".length);
    const segments = relativePath.split("/");
    if (relativePath === "" || segments.some((segment) => segment === "")) {
      failure("ARCHIVE_UNSAFE_PATH", `invalid archive entry: ${JSON.stringify(name)}`);
    }
    const bytes = await runTar(["-xOzf", archivePath, name]);
    entries.push({ name, relativePath, bytes });
  }

  const files = new Map(entries.map((entry) => [entry.relativePath, entry]));
  return { entries, files };
}

function isPublicNpmTarballUrl(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "registry.npmjs.org" &&
    (url.port === "" || url.port === "443") &&
    url.username === "" &&
    url.password === ""
  );
}

function sriHasMatchingSha512(integrity, expectedBase64) {
  if (typeof integrity !== "string" || integrity.trim() === "") return false;
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match) continue;
    const actual = Buffer.from(match[1], "base64");
    const expected = Buffer.from(expectedBase64, "base64");
    if (actual.length === expected.length && actual.equals(expected)) return true;
  }
  return false;
}

/** Runs fetch and body consumption under one cancellable timeout; the race also bounds signal-ignoring fetch. */
async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, timeoutCode, consume, onHeaders) {
  const controller = new AbortController();
  const timeoutError = new VerificationError(timeoutCode, `request timed out after ${timeoutMs}ms: ${url}`);
  let timer;
  const deadlinePromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        controller.abort();
      } catch {
        // Abort is best effort; the race below still stops the wait.
      }
      reject(timeoutError);
    }, timeoutMs);
  });
  const work = (async () => {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      if (error instanceof VerificationError) throw error;
      failure(timeoutCode.replace("_TIMEOUT", "_FETCH_FAILED"),
        `request failed for ${url}: ${error?.message ?? error}`);
    }
    try {
      onHeaders?.(response);
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError;
      if (error instanceof VerificationError) throw error;
      failure(timeoutCode.replace("_TIMEOUT", "_READ_FAILED"),
        `could not read response body for ${url}: ${error?.message ?? error}`);
    }
  })();
  // A signal-ignoring fetch may settle after the timer wins; never leak that rejection.
  work.catch(() => {});
  try {
    return await Promise.race([work, deadlinePromise]);
  } finally {
    clearTimeout(timer);
  }
}

function rememberFirstPendingError(receipt, code, message, status, timestamp) {
  if (receipt.metadata.firstError !== null) return;
  const at = utc(timestamp);
  receipt.metadata.firstError = { at, status, code, message };
  receipt.metadata.firstErrorAt = at;
}

function processingPending() {
  return new VerificationError(
    "PROCESSING_PENDING",
    `target version did not become visible within ${METADATA_MAX_WAIT_MS / 60_000} minutes`,
    { pending: true },
  );
}

async function waitForMetadata({ options, deps, receipt, archiveReadmeBytes }) {
  const metadataUrl = `${REGISTRY}${options.package}`;
  receipt.metadata.url = metadataUrl;
  const startedAt = deps.now();
  const deadline = startedAt + METADATA_MAX_WAIT_MS;

  for (;;) {
    const attemptAt = deps.now();
    const remainingMs = deadline - attemptAt;
    if (remainingMs <= 0) {
      throw processingPending();
    }
    const requestTimeoutMs = Math.min(deps.requestTimeoutMs, remainingMs);
    receipt.metadataAttemptCount += 1;
    const attempt = {
      at: utc(attemptAt),
      status: null,
      outcome: "pending",
      timeoutMs: requestTimeoutMs,
    };
    try {
      const response = await fetchWithTimeout(
        deps.fetch,
        metadataUrl,
        { headers: { accept: "application/json" }, redirect: "follow" },
        requestTimeoutMs,
        "METADATA_TIMEOUT",
        async (rawResponse) => ({
          status: rawResponse.status,
          ok: rawResponse.ok,
          url: rawResponse.url,
          text: await rawResponse.text(),
        }),
        (rawResponse) => {
          attempt.status = rawResponse.status;
        },
      );
      attempt.status = response.status;
      if (response.status === 404) {
        attempt.outcome = "version-not-visible";
        rememberFirstPendingError(
          receipt,
          "VERSION_NOT_VISIBLE",
          `registry returned 404 for ${options.package}@${options.version}`,
          404,
          attemptAt,
        );
      } else if (response.status === 401 || response.status === 403) {
        attempt.outcome = "auth-error";
        failure(
          "METADATA_AUTH_ERROR",
          `registry returned HTTP ${response.status}; refusing to continue with authentication/authorization errors`,
        );
      } else if (!response.ok) {
        attempt.outcome = "http-error";
        failure("METADATA_HTTP_ERROR", `registry returned HTTP ${response.status}`);
      } else {
        let document;
        try {
          document = JSON.parse(response.text);
        } catch (error) {
          failure("METADATA_INVALID_JSON", `registry metadata is not valid JSON: ${error?.message ?? error}`);
        }
        if (document === null || typeof document !== "object" || Array.isArray(document)) {
          failure("METADATA_INVALID_JSON", "registry metadata is not a JSON object");
        }
        const target = document.versions?.[options.version];
        if (target === undefined) {
          attempt.outcome = "version-missing";
          rememberFirstPendingError(
            receipt,
            "VERSION_MISSING",
            `registry metadata does not list ${options.package}@${options.version} yet`,
            200,
            attemptAt,
          );
        } else {
          attempt.outcome = "target-found";
          receipt.metadata.foundAt = utc(attemptAt);
          validateMetadata({ options, document, target, archiveReadmeBytes });
          return { document, target };
        }
      }
    } catch (error) {
      if (error instanceof VerificationError) {
        attempt.outcome = error.code === "METADATA_TIMEOUT" ? "timeout" : "error";
        attempt.errorCode = error.code;
        attempt.errorMessage = error.message;
      }
      throw error;
    } finally {
      receipt.metadataAttempts.push(attempt);
    }
    const now = deps.now();
    if (now >= deadline) {
      throw processingPending();
    }
    await deps.sleep(Math.min(METADATA_INTERVAL_MS, deadline - now));
    if (deps.now() >= deadline) {
      throw processingPending();
    }
  }
}

function validateMetadata({ options, document, target, archiveReadmeBytes }) {
  if (target.name !== options.package) {
    failure(
      "METADATA_NAME_MISMATCH",
      `target name mismatch: expected ${options.package}, got ${JSON.stringify(target.name)}`,
    );
  }
  if (target.version !== options.version) {
    failure(
      "METADATA_VERSION_MISMATCH",
      `target version mismatch: expected ${options.version}, got ${JSON.stringify(target.version)}`,
    );
  }
  if (options.expectLatest) {
    const latest = document["dist-tags"]?.latest;
    if (latest !== options.version) {
      failure(
        "LATEST_MISMATCH",
        `dist-tags.latest is ${JSON.stringify(latest)}, expected ${options.version}`,
      );
    }
  }
  const integrity = target.dist?.integrity;
  if (!sriHasMatchingSha512(integrity, options.archiveSha512Base64)) {
    failure(
      "INTEGRITY_MISMATCH",
      "dist.integrity has no SHA-512 value matching the frozen archive",
    );
  }
  if (!isPublicNpmTarballUrl(target.dist?.tarball)) {
    failure(
      "TARBALL_URL_UNSAFE",
      `tarball must be a public HTTPS URL on registry.npmjs.org, got ${JSON.stringify(target.dist?.tarball)}`,
    );
  }
  const metadataReadme = document.readme ?? target.readme;
  if (typeof metadataReadme !== "string") {
    failure("README_MISSING", "registry metadata has no README string");
  }
  if (!Buffer.from(metadataReadme, "utf8").equals(archiveReadmeBytes)) {
    failure("README_MISMATCH", "registry metadata README does not match the archive README");
  }
}

async function downloadTarball({ options, deps, receipt, target }) {
  receipt.phase = "tarball";
  const url = target.dist.tarball;
  if (!isPublicNpmTarballUrl(url)) {
    failure("TARBALL_URL_UNSAFE", "refusing to download a tarball outside the public npm registry");
  }

  const response = await fetchWithTimeout(
    deps.fetch,
    url,
    { headers: { accept: "application/octet-stream" }, redirect: "follow" },
    deps.requestTimeoutMs,
    "TARBALL_TIMEOUT",
    async (rawResponse) => ({
      status: rawResponse.status,
      ok: rawResponse.ok,
      url: rawResponse.url,
      bytes: Buffer.from(await rawResponse.arrayBuffer()),
    }),
  );
  if (response.status === 401 || response.status === 403) {
    failure("TARBALL_AUTH_ERROR", `tarball request returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    failure("TARBALL_HTTP_ERROR", `tarball request returned HTTP ${response.status}`);
  }
  if (response.url && !isPublicNpmTarballUrl(response.url)) {
    failure("TARBALL_URL_UNSAFE", `tarball redirected outside registry.npmjs.org: ${response.url}`);
  }

  const bytes = response.bytes;

  const actualSha256 = sha256Hex(bytes);
  receipt.tarball = {
    url,
    sha256: actualSha256,
    bytes: bytes.length,
    downloadedAt: utc(deps.now()),
  };
  if (actualSha256 !== options.sha256.toLowerCase()) {
    failure(
      "TARBALL_SHA256_MISMATCH",
      `downloaded tarball SHA-256 ${actualSha256} does not match --sha256 ${options.sha256.toLowerCase()}`,
    );
  }
  if (!bytes.equals(options.archiveBytes)) {
    failure("TARBALL_BYTES_MISMATCH", "downloaded tarball bytes differ from the frozen archive");
  }
}

/** Builds the one real install command; latest mode must stay unversioned. */
export function buildInstallArgs({ packageName, version, expectLatest }) {
  const packageSpec = expectLatest ? packageName : `${packageName}@${version}`;
  return [
    "install",
    packageSpec,
    "--no-audit",
    "--no-fund",
    "--registry",
    REGISTRY,
  ];
}

async function defaultRunInstall({ cwd, packageName, version, expectLatest, timeoutMs }) {
  const userconfig = path.join(cwd, ".empty-user-npmrc");
  const globalconfig = path.join(cwd, ".empty-global-npmrc");
  await fs.writeFile(userconfig, "");
  await fs.writeFile(globalconfig, "");
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(key)) continue;
    if (/^(?:BLOCKVECTRA_API_KEY|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN)$/i.test(key)) continue;
    env[key] = value;
  }
  env.npm_config_userconfig = userconfig;
  env.npm_config_globalconfig = globalconfig;
  env.npm_config_registry = REGISTRY;
  const args = buildInstallArgs({ packageName, version, expectLatest });
  const result = await execFileBuffer("npm", args, {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ...result, command: `npm ${args.join(" ")}` };
}

function normalizeLog(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value === undefined || value === null) return Buffer.from("");
  return Buffer.from(String(value));
}

async function writeInstallLogs(logs, result) {
  await fs.writeFile(logs.stdout, normalizeLog(result.stdout));
  await fs.writeFile(logs.stderr, normalizeLog(result.stderr));
}

function probeEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_config_/i.test(key)) continue;
    if (/^(?:BLOCKVECTRA_API_KEY|NPM_TOKEN|NODE_AUTH_TOKEN|NPM_AUTH_TOKEN)$/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

const ESM_PROBE_SOURCE = `
const expected = ${JSON.stringify(REQUIRED_EXPORTS)};
const pkg = await import(${JSON.stringify(PACKAGE_NAME)});
const missing = expected.filter((name) => !(name in pkg));
if (missing.length > 0) { console.error("PROBE_EXPORTS_MISSING " + missing.join(",")); process.exit(11); }
if (typeof pkg.createDataClient !== "function" || typeof pkg.isDataApiError !== "function" || typeof pkg.DEFAULT_BASE_URL !== "string" || pkg.DEFAULT_BASE_URL === "") { console.error("PROBE_EXPORTS_INVALID"); process.exit(12); }
let rejected = false;
let rejection;
try { pkg.createDataClient({ apiKey: "", fetch: () => { throw new Error("verify-publication must not make a business API request"); } }); }
catch (error) { rejected = true; rejection = error; }
if (!rejected) { console.error("PROBE_EMPTY_KEY_ACCEPTED"); process.exit(13); }
if (!(rejection instanceof TypeError)) { console.error("PROBE_EMPTY_KEY_WRONG_ERROR " + (rejection?.name ?? "unknown")); process.exit(14); }
console.log(JSON.stringify({ entry: ${JSON.stringify(PACKAGE_NAME)}, exports: expected, emptyKeyRejected: true }));
`;

/** Runs the probe from an isolated consumer with its own package.json, using the public package name. */
async function runEsmProbe(consumerRoot) {
  const result = await execFileBuffer(
    process.execPath,
    ["--input-type=module", "-e", ESM_PROBE_SOURCE],
    { cwd: consumerRoot, env: probeEnvironment(), timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );
  return {
    command: "node --input-type=module -e <esm-probe>",
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

async function validateInstalledPackage({ options, receipt, consumerRoot, runInstallResult }) {
  receipt.phase = "verify-install";
  const installedDir = path.join(consumerRoot, "node_modules", ...options.package.split("/"));
  const installedPackageJsonPath = path.join(installedDir, "package.json");
  let installedPackageJson;
  try {
    installedPackageJson = JSON.parse(await fs.readFile(installedPackageJsonPath, "utf8"));
  } catch (error) {
    failure(
      "INSTALLED_PACKAGE_MISSING",
      `installed package.json is missing or invalid: ${error?.message ?? error}`,
    );
  }
  if (installedPackageJson.name !== options.package) {
    failure(
      "INSTALLED_NAME_MISMATCH",
      `installed name mismatch: expected ${options.package}, got ${JSON.stringify(installedPackageJson.name)}`,
    );
  }
  if (installedPackageJson.version !== options.version) {
    failure(
      "INSTALLED_VERSION_MISMATCH",
      `installed version mismatch: expected ${options.version}, got ${JSON.stringify(installedPackageJson.version)}`,
    );
  }
  for (const entry of options.archiveEntries) {
    const installedPath = path.join(installedDir, ...entry.relativePath.split("/"));
    let installedBytes;
    try {
      installedBytes = await fs.readFile(installedPath);
    } catch (error) {
      failure(
        "INSTALLED_FILE_MISSING",
        `installed package is missing ${entry.relativePath}: ${error?.message ?? error}`,
      );
    }
    if (!installedBytes.equals(entry.bytes)) {
      failure(
        "INSTALLED_FILE_MISMATCH",
        `installed file differs byte-for-byte from the archive: ${entry.relativePath}`,
      );
    }
  }
  receipt.install.filesChecked = options.archiveEntries.length;
  const probe = await runEsmProbe(consumerRoot);
  receipt.install.esm = { entry: PACKAGE_NAME, exports: REQUIRED_EXPORTS, probe };
  if (probe.exitCode !== 0) {
    const codeByExit = {
      11: "INSTALLED_EXPORTS_MISSING",
      12: "INSTALLED_EXPORTS_INVALID",
      13: "EMPTY_KEY_ACCEPTED",
      14: "EMPTY_KEY_WRONG_ERROR",
    };
    const code = codeByExit[probe.exitCode] ?? "INSTALLED_IMPORT_FAILED";
    const detail = probe.stderr.trim().split(/\r?\n/)[0] ?? "";
    failure(
      code,
      `isolated package probe exited with ${probe.exitCode}${probe.signal ? ` (signal ${probe.signal})` : ""}${probe.spawnError ? ` (${probe.spawnError})` : ""}${detail ? `: ${detail}` : ""}`,
    );
  }

  let probeOutput;
  try {
    probeOutput = JSON.parse(probe.stdout.trim());
  } catch (error) {
    failure("INSTALLED_ESM_PROBE_INVALID", `isolated package probe did not emit valid JSON: ${error?.message ?? error}`);
  }
  if (
    probeOutput.emptyKeyRejected !== true ||
    !Array.isArray(probeOutput.exports) ||
    REQUIRED_EXPORTS.some((name) => !probeOutput.exports.includes(name))
  ) {
    failure("INSTALLED_ESM_PROBE_INVALID", "isolated package probe did not confirm the required exports and empty-key rejection");
  }
  receipt.install.esm.emptyKeyRejected = true;
  receipt.install.run = {
    command: runInstallResult.command ?? null,
    exitCode: runInstallResult.exitCode,
  };
}

/**
 * Runs the acceptance check. Network, clock, sleep, and install are small
 * injectable boundaries so tests can stay offline and deterministic.
 */
export async function verifyPublication(options, dependencies = {}) {
  const deps = {
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? Date.now,
    sleep: dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    runInstall: dependencies.runInstall ?? defaultRunInstall,
    requestTimeoutMs: dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  };
  if (typeof deps.fetch !== "function") {
    throw new TypeError("verifyPublication requires a fetch implementation");
  }

  const startedAt = deps.now();
  const receipt = makeBaseReceipt(
    {
      package: options.package,
      version: options.version,
      archive: options.archive,
      sha256: options.sha256,
      source: options.source,
      tree: options.tree,
      out: options.out,
    },
    options.expectLatest,
    startedAt,
  );

  let consumerRoot = null;
  const tempParent = path.join(process.cwd(), ".tmp");

  try {
    const argumentErrors = validateArguments(
      {
        package: options.package,
        version: options.version,
        archive: options.archive,
        sha256: options.sha256,
        source: options.source,
        tree: options.tree,
        out: options.out,
      },
      options.expectLatest,
    );
    if (argumentErrors.length > 0) {
      failure("INVALID_ARGUMENTS", argumentErrors.join("; "));
    }

    receipt.phase = "archive";
    const archivePath = path.resolve(options.archive);
    let archiveBytes;
    try {
      const stat = await fs.stat(archivePath);
      if (!stat.isFile()) failure("ARCHIVE_NOT_FILE", `archive is not a regular file: ${archivePath}`);
      archiveBytes = await fs.readFile(archivePath);
    } catch (error) {
      if (error instanceof VerificationError) throw error;
      failure("ARCHIVE_READ_FAILED", `could not read archive ${archivePath}: ${error?.message ?? error}`);
    }

    const archiveSha256 = sha256Hex(archiveBytes);
    receipt.archiveSha256 = archiveSha256;
    receipt.archiveSha256Actual = archiveSha256;
    if (archiveSha256 !== options.sha256.toLowerCase()) {
      failure(
        "ARCHIVE_SHA256_MISMATCH",
        `archive SHA-256 ${archiveSha256} does not match --sha256 ${options.sha256.toLowerCase()}`,
      );
    }

    const archive = await readArchive(archivePath);
    const packageJsonEntry = archive.files.get("package.json");
    if (packageJsonEntry === undefined) {
      failure("ARCHIVE_PACKAGE_JSON_MISSING", "archive has no package/package.json");
    }
    let archivePackageJson;
    try {
      archivePackageJson = JSON.parse(packageJsonEntry.bytes.toString("utf8"));
    } catch (error) {
      failure("ARCHIVE_PACKAGE_JSON_INVALID", `archive package.json is invalid: ${error?.message ?? error}`);
    }
    if (archivePackageJson.name !== options.package) {
      failure(
        "ARCHIVE_NAME_MISMATCH",
        `archive package name mismatch: expected ${options.package}, got ${JSON.stringify(archivePackageJson.name)}`,
      );
    }
    if (archivePackageJson.version !== options.version) {
      failure(
        "ARCHIVE_VERSION_MISMATCH",
        `archive package version mismatch: expected ${options.version}, got ${JSON.stringify(archivePackageJson.version)}`,
      );
    }
    const readmeEntry = archive.files.get("README.md");
    if (readmeEntry === undefined) failure("ARCHIVE_README_MISSING", "archive has no package/README.md");

    options = {
      ...options,
      archiveBytes,
      archiveEntries: archive.entries,
      archiveSha512Base64: sha512Base64(archiveBytes),
    };

    receipt.phase = "metadata";
    const { target } = await waitForMetadata({
      options,
      deps,
      receipt,
      archiveReadmeBytes: readmeEntry.bytes,
    });

    await downloadTarball({ options, deps, receipt, target });

    receipt.phase = "install";
    await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
    await fs.mkdir(tempParent, { recursive: true });
    consumerRoot = await fs.mkdtemp(path.join(tempParent, "verify-publication-"));
    // The consumer owns its package.json so a bare import cannot self-reference
    // the SDK checkout this verifier lives in.
    await fs.writeFile(
      path.join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "verify-publication-consumer", private: true, type: "module" }, null, 2)}\n`,
    );
    const outputTarget = path.resolve(options.out);
    const logs = {
      stdout: `${outputTarget}.install.stdout.log`,
      stderr: `${outputTarget}.install.stderr.log`,
    };
    receipt.install.stdoutPath = logs.stdout;
    receipt.install.stderrPath = logs.stderr;

    receipt.install.attempts = 1;
    receipt.install.startedAt = utc(deps.now());
    let installResult;
    try {
      installResult = await deps.runInstall({
        cwd: consumerRoot,
        packageName: options.package,
        version: options.version,
        expectLatest: Boolean(options.expectLatest),
        registry: REGISTRY,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      installResult = {
        command: "npm install (runner failed before reporting)",
        exitCode: null,
        signal: null,
        stdout: Buffer.from(""),
        stderr: Buffer.from(`install runner failed: ${error?.stack ?? error}\n`),
      };
    } finally {
      if (installResult !== undefined) await writeInstallLogs(logs, installResult);
    }
    receipt.install.finishedAt = utc(deps.now());
    receipt.install.exitCode = installResult.exitCode;
    receipt.install.signal = installResult.signal ?? null;
    receipt.install.spawnError = installResult.spawnError ?? null;
    receipt.install.command = installResult.command ?? null;

    if (installResult.exitCode !== 0) {
      const detail =
        installResult.signal !== null && installResult.signal !== undefined
          ? ` (signal ${installResult.signal})`
          : installResult.spawnError
            ? ` (${installResult.spawnError})`
            : "";
      failure(
        "INSTALL_FAILED",
        `npm install exited with ${installResult.exitCode}${detail}; see ${logs.stderr}`,
      );
    }

    await validateInstalledPackage({
      options,
      receipt,
      consumerRoot,
      runInstallResult: installResult,
    });

    receipt.status = "PASS";
    receipt.phase = "complete";
  } catch (error) {
    const verificationError =
      error instanceof VerificationError
        ? error
        : new VerificationError("INTERNAL_ERROR", error?.stack ?? String(error));
    receipt.status = verificationError.pending ? "PROCESSING_PENDING" : "FAIL";
    receipt.error = {
      code: verificationError.code,
      message: verificationError.message,
    };
  } finally {
    if (consumerRoot !== null) {
      try {
        await fs.rm(consumerRoot, { recursive: true, force: true });
        receipt.install.consumerRemoved = true;
      } catch (error) {
        receipt.install.consumerRemoved = false;
        receipt.install.cleanupError = error?.message ?? String(error);
        if (receipt.status === "PASS") {
          receipt.status = "FAIL";
          receipt.error = {
            code: "CLEANUP_FAILED",
            message: `could not remove temporary consumer: ${error?.message ?? error}`,
          };
        }
      }
      try {
        await fs.rmdir(tempParent);
      } catch {
        // Keep a shared non-empty .tmp untouched; only the unique consumer is ours.
      }
    }

    receipt.finishedAt = utc(deps.now());
    receipt.durationMs = deps.now() - startedAt;
    await writeReceiptFile(options.out, receipt);
  }

  return receipt;
}

/** CLI entry: handles argument-only failures before any network is attempted. */
export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const parsed = parseArgs(argv);
  const out = parsed.values.out;

  if (typeof out !== "string" || out.trim() === "") {
    console.error("verify-publication: --out <receipt.json> is required");
    return 2;
  }

  const argumentErrors = [...parsed.errors, ...validateArguments(parsed.values, parsed.expectLatest)];
  if (argumentErrors.length > 0) {
    const receipt = makeBaseReceipt(parsed.values, parsed.expectLatest, now());
    receipt.phase = "arguments";
    receipt.status = "FAIL";
    receipt.error = { code: "INVALID_ARGUMENTS", message: argumentErrors.join("; ") };
    receipt.finishedAt = utc(now());
    const target = await writeReceiptFile(out, receipt);
    for (const error of argumentErrors) console.error(`verify-publication: ${error}`);
    console.error(`verify-publication: receipt written to ${target}`);
    return 2;
  }

  const options = {
    package: parsed.values.package,
    version: parsed.values.version,
    archive: path.resolve(parsed.values.archive),
    sha256: parsed.values.sha256.toLowerCase(),
    source: parsed.values.source,
    tree: parsed.values.tree,
    out: path.resolve(out),
    expectLatest: parsed.expectLatest,
  };

  let receipt;
  try {
    receipt = await verifyPublication(options, dependencies);
  } catch (error) {
    console.error(`verify-publication: ${error?.message ?? error}`);
    return 1;
  }

  if (receipt.status === "PASS") {
    console.log(`verify-publication: PASS ${options.package}@${options.version}`);
    console.log(`receipt: ${options.out}`);
    return 0;
  }
  console.error(`verify-publication: ${receipt.status} at ${receipt.phase}: ${receipt.error?.message ?? ""}`);
  console.error(`receipt: ${options.out}`);
  return receipt.status === "PROCESSING_PENDING" ? 2 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`verify-publication: ${error?.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
