import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const temporary = await mkdtemp(path.join(os.tmpdir(), "datum-pack-"));
const npmCache = path.join(temporary, "npm-cache");
const consumer = path.join(temporary, "consumer");
const packageDestination = process.env.DATUM_PACK_DESTINATION
  ? path.resolve(process.env.DATUM_PACK_DESTINATION)
  : path.join(temporary, "artifacts");
const preinstallTarballs = (process.env.KONTOUR_PACK_PREINSTALL_TARBALLS ?? "")
  .split(path.delimiter)
  .filter(Boolean)
  .map((tarball) => path.resolve(tarball));

try {
  await mkdir(packageDestination, { recursive: true });
  const { stdout } = await execFileAsync(
    "npm",
    [
      "pack",
      "--dry-run=false",
      "--json",
      "--pack-destination",
      packageDestination,
      "--cache",
      npmCache,
    ],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const entries = parsePackJson(stdout);
  if (entries.length !== 1) throw new Error(`Expected one npm pack entry, found ${entries.length}.`);

  const entry = entries[0];
  if (entry.name !== packageJson.name) throw new Error(`Unexpected package name: ${entry.name}`);
  if (entry.version !== packageJson.version) throw new Error(`Unexpected package version: ${entry.version}`);
  if (entry.bundled?.length) throw new Error(`Package must not bundle dependencies: ${entry.bundled.join(", ")}`);

  const files = entry.files.map((file) => file.path).sort();
  const expectedFiles = [
    "LICENSE",
    "README.md",
    "bin/datum.mjs",
    "datum.schema.json",
    "dist/src/auth.d.ts",
    "dist/src/auth.js",
    "dist/src/claudecode.d.ts",
    "dist/src/claudecode.js",
    "dist/src/catalog.d.ts",
    "dist/src/catalog.js",
    "dist/src/catalog/cache.d.ts",
    "dist/src/catalog/cache.js",
    "dist/src/catalog/limits.d.ts",
    "dist/src/catalog/limits.js",
    "dist/src/catalog/shared.d.ts",
    "dist/src/catalog/shared.js",
    "dist/src/catalog/snapshot.d.ts",
    "dist/src/catalog/snapshot.js",
    "dist/src/catalog/source.d.ts",
    "dist/src/catalog/source.js",
    "dist/src/catalog/transport.d.ts",
    "dist/src/catalog/transport.js",
    "dist/src/catalog/types.d.ts",
    "dist/src/catalog/types.js",
    "dist/src/capability-role.d.ts",
    "dist/src/capability-role.js",
    "dist/src/config.d.ts",
    "dist/src/config.js",
    "dist/src/discover.d.ts",
    "dist/src/discover.js",
    "dist/src/doctor.d.ts",
    "dist/src/doctor.js",
    "dist/src/errors.d.ts",
    "dist/src/errors.js",
    "dist/src/index.d.ts",
    "dist/src/index.js",
    "dist/src/opencode.d.ts",
    "dist/src/opencode.js",
    "dist/src/resolve.d.ts",
    "dist/src/resolve.js",
    "dist/src/secrets.d.ts",
    "dist/src/secrets.js",
    "dist/src/security.d.ts",
    "dist/src/security.js",
    "dist/src/types.d.ts",
    "dist/src/types.js",
    "dist/src/validate.d.ts",
    "dist/src/validate.js",
    "package.json",
  ].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    const actual = new Set(files);
    const expected = new Set(expectedFiles);
    const missing = expectedFiles.filter((file) => !actual.has(file));
    const unexpected = files.filter((file) => !expected.has(file));
    throw new Error(
      `Package contents differ from the exact allowlist. Missing: ${formatList(missing)}. ` +
        `Unexpected: ${formatList(unexpected)}.`,
    );
  }

  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  if (preinstallTarballs.length > 0) {
    await execFileAsync(
      "npm",
      [
        "install",
        "--dry-run=false",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        npmCache,
        ...preinstallTarballs,
      ],
      { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
    );
  }
  await execFileAsync(
    "npm",
    [
      "install",
      "--dry-run=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      npmCache,
      path.join(packageDestination, entry.filename),
      ...preinstallTarballs,
    ],
    { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
  );
  await execFileAsync(
    "node",
    [
      "--input-type=module",
      "--eval",
      [
        'import * as datum from "@kontourai/datum";',
        'if (typeof datum.validateConfig !== "function") throw new Error("missing validateConfig");',
        'if (typeof datum.resolveRef !== "function") throw new Error("missing resolveRef");',
        'if (typeof datum.resolveCapabilityRole !== "function") throw new Error("missing resolveCapabilityRole");',
        'if (typeof datum.loadCapabilityCatalog !== "function") throw new Error("missing loadCapabilityCatalog");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execFileAsync(
    "node",
    [path.join(consumer, "node_modules", ".bin", "datum"), "--help"],
    { cwd: consumer },
  );

  console.log(
    `Datum package contents and clean-consumer checks passed: ${files.length} files; ` +
      `artifact ${path.join(packageDestination, entry.filename)}.`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function parsePackJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Could not find npm pack JSON in output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function formatList(items) {
  return items.length ? items.join(", ") : "(none)";
}
