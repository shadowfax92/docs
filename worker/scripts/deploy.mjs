import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdtemp, open, rm, symlink } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/** Deployment module: the CLI seam owns local secret persistence and ordered Wrangler calls.
 * Filesystem/crypto are local dependencies; Wrangler is the true external adapter. Values cross
 * that process seam only as catalog JSON stdin. Plans perform reads only, including no children.
 * Requires Node 22.16+ on macOS/Linux and the repository's installed, logged-in local Wrangler.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretNames = ["ALL_DOCS_PASSWORD", "CATALOG_SESSION_KEY"];
class RecipeError extends Error {}
const fail = (message) => { throw new RecipeError(message); };

// Validate a conservative dotenv grammar before using Node's parser, which otherwise silently
// accepts malformed/unclosed assignments. Preserve every original byte when appending the key.
// Literal quoted multiline values are supported; shell expansion/escaped quotes are not.
function secretsFrom(text) {
  const entry = /[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)|[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(?:'[^']*'|"[^"]*"|`[^`]*`|[^#\r\n'"`]*?)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/y;
  const seen = new Set();
  let offset = 0;
  while (offset < text.length) {
    entry.lastIndex = offset;
    const match = entry.exec(text);
    if (!match || !match[0].length) fail("Invalid worker/.env syntax; use literal dotenv assignments (no shell expansion or escaped quotes).");
    if (secretNames.includes(match[1])) {
      if (seen.has(match[1])) fail(`Duplicate ${match[1]} in worker/.env.`);
      seen.add(match[1]);
    }
    offset = entry.lastIndex;
  }
  const values = parseEnv(text);
  const password = values.ALL_DOCS_PASSWORD;
  const key = values.CATALOG_SESSION_KEY;
  const valid = (value, min) => typeof value === "string" && !value.includes("\0")
    && Buffer.byteLength(value) >= min && Buffer.byteLength(value) <= 1024;
  if (!valid(password, 1)) fail("worker/.env requires ALL_DOCS_PASSWORD (1..1024 UTF-8 bytes).");
  if (key !== undefined && (!valid(key, 32) || key === password)) {
    fail("CATALOG_SESSION_KEY must be independent of the password and contain 32..1024 UTF-8 bytes; remove the assignment to generate a new key.");
  }
  return { ALL_DOCS_PASSWORD: password, ...(key !== undefined && { CATALOG_SESSION_KEY: key }) };
}

async function main() {
  const args = process.argv.slice(2);
  const role = args.shift();
  if (!["all", "public", "catalog"].includes(role) || args.some((arg) => !["--plan", "--public-ready"].includes(arg))
    || new Set(args).size !== args.length) {
    fail("Usage: node scripts/deploy.mjs all|public|catalog [--plan] [--public-ready]");
  }
  if (Number(process.versions.node.split(".")[0]) < 22
    || (process.versions.node.startsWith("22.") && Number(process.versions.node.split(".")[1]) < 16)
    || process.platform === "win32") fail("Use Node 22.16+ on macOS/Linux.");
  const plan = args.includes("--plan");
  if (role === "catalog" && !args.includes("--public-ready")) {
    fail("Catalog-only requires --public-ready: first deploy/coordinate the immutable public writer and finish old in-flight uploads. This flag does not verify drainage.");
  }
  for (const config of role === "public" ? ["wrangler.toml"] : ["wrangler.toml", "wrangler.catalog.toml"]) {
    try { await access(join(root, config), constants.R_OK); }
    catch { fail(`Missing or unreadable worker/${config}.`); }
  }

  const deploy = (config) => ["deploy", "--no-bundle", "--config", config];
  const steps = [
    ...(role !== "catalog" ? [{ label: "public source (retains existing AUTH_TOKEN)", args: deploy("wrangler.toml") }] : []),
    ...(role !== "public" ? [
      // Always deploy source before bulk: a new catalog is fail-closed without its secrets,
      // avoiding secret bulk's implicit draft-worker creation. Existing secrets are retained.
      { label: "catalog source/bootstrap (new catalog fails closed)", args: deploy("wrangler.catalog.toml") },
      { label: `catalog secrets: ${secretNames.join(", ")} (redacted JSON stdin)`, args: ["secret", "bulk", "--config", "wrangler.catalog.toml"], secrets: true },
      { label: "final catalog source with provisioned secrets", args: deploy("wrangler.catalog.toml") },
    ] : []),
  ];
  let lock, envFile, logDirectory, child, interrupted;
  const interrupt = (signal) => {
    interrupted = signal;
    // npx starts Wrangler as a descendant. Forward cancellation to the owned process group,
    // and keep the local lock until its child closes; never start a later deployment step.
    if (child?.pid) {
      try { process.kill(-child.pid, signal); } catch { /* The child may already have exited. */ }
    }
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    // Serialize live invocations so two runs cannot generate different signing keys. A crash
    // can leave the empty lock; operators remove it only after checking no deployment is active.
    if (!plan) {
      try { lock = await open(join(root, ".env.deploy.lock"), "wx", 0o600); }
      catch { fail("Cannot acquire worker/.env.deploy.lock; check file access or another active deployment. Remove a stale lock only after checking no run is active."); }
    }
    let secrets;
    if (role !== "public") {
      try {
        envFile = await open(join(root, ".env"), (plan ? constants.O_RDONLY : constants.O_RDWR) | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch { fail("Missing/unreadable worker/.env, or it is a symlink. Create a private regular file from worker/.env.example and set ALL_DOCS_PASSWORD."); }
      const info = await envFile.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > 1024 * 1024) {
        fail("worker/.env must be an owned regular file with one hard link, smaller than 1 MiB.");
      }
      const text = await envFile.readFile("utf8");
      secrets = secretsFrom(text);
      if (plan) {
        console.log("PLAN ONLY: no commands, file writes, permission changes or cloud mutations.");
        console.log("Local: enforce worker/.env mode 0600; " + (secrets.CATALOG_SESSION_KEY === undefined
          ? "generate/persist CATALOG_SESSION_KEY from 32 random bytes on execution."
          : "reuse persistent CATALOG_SESSION_KEY."));
      } else {
        // Validate every input and local dependency before persisting anything or mutating cloud.
        try { await access(join(root, "node_modules/.bin/wrangler"), constants.X_OK); }
        catch { fail("Local Wrangler is missing; run npm ci in worker first."); }
        await envFile.chmod(0o600);
        if (secrets.CATALOG_SESSION_KEY === undefined) {
          secrets.CATALOG_SESSION_KEY = randomBytes(32).toString("hex");
          const newline = text.includes("\r\n") ? "\r\n" : "\n";
          const addition = `${text && !text.endsWith("\n") ? newline : ""}CATALOG_SESSION_KEY=${secrets.CATALOG_SESSION_KEY}${newline}`;
          await envFile.write(addition, info.size, "utf8");
          await envFile.sync();
        }
      }
      await envFile.close();
      envFile = undefined;
    } else if (plan) {
      console.log("PLAN ONLY: no commands, file writes, permission changes or cloud mutations.");
    }
    if (plan) {
      for (const [index, step] of steps.entries()) console.log(`${index + 1}. npx --no-install wrangler ${step.args.join(" ")} # ${step.label}`);
      return;
    }
    try { await access(join(root, "node_modules/.bin/wrangler"), constants.X_OK); }
    catch { fail("Local Wrangler is missing; run npm ci in worker first."); }

    // Wrangler 3 loads .env into its process environment and writes debug logs independently
    // of stdout. Mask credentials there and send all child/debug output to the null device,
    // including errors which could echo a rejected value. No secret-bearing temp files exist.
    logDirectory = await mkdtemp(join(tmpdir(), "docs-deploy-"));
    const logPath = join(logDirectory, "wrangler.log");
    await symlink(devNull, logPath);
    const childEnv = { ...process.env, CI: "true", BROWSER: "none", npm_config_yes: "false",
      WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_SANITIZE: "true", WRANGLER_LOG_PATH: logPath,
      WRANGLER_OUTPUT_FILE_PATH: devNull, WRANGLER_OUTPUT_FILE_DIRECTORY: logDirectory,
      ALL_DOCS_PASSWORD: "", CATALOG_SESSION_KEY: "", AUTH_TOKEN: "" };
    for (const [index, step] of steps.entries()) {
      if (interrupted) fail(`Interrupted (${interrupted}); later steps were not started. Rerun after checking deployment state.`);
      console.log(`${index + 1}/${steps.length}: ${step.label}`);
      await new Promise((resolveStep, reject) => {
        child = spawn("npx", ["--no-install", "wrangler", ...step.args], {
          cwd: root, env: childEnv, detached: true, stdio: ["pipe", "ignore", "ignore"], shell: false,
        });
        // EPIPE can race an early authentication/CLI failure. Report only the exit result;
        // do not let a raw stream exception print stdin content or obscure earlier success.
        child.stdin.on("error", () => {});
        child.once("error", () => reject(new RecipeError("Could not start local npx Wrangler; check npm/Node installation.")));
        child.once("close", (code, signal) => {
          child = undefined;
          if (code === 0 && !interrupted) resolveStep();
          else reject(new RecipeError(`Deployment step ${index + 1} failed (${signal || code}); later steps were not started. Child output is suppressed to protect secrets. Check local login with npx wrangler login separately, then rerun after checking deployment state.`));
        });
        child.stdin.end(step.secrets ? JSON.stringify(secrets) : "");
      });
    }
    console.log("Deployment recipe completed. Verify live behavior separately; this does not prove old in-flight writer drainage.");
  } finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    await envFile?.close();
    if (lock) {
      await lock.close();
      await rm(join(root, ".env.deploy.lock"));
    }
    if (logDirectory) await rm(logDirectory, { recursive: true });
  }
}

main().catch((error) => {
  // Native parser/filesystem/child errors are deliberately not interpolated: their message or
  // stack may contain user-controlled .env content. Only our static diagnostics reach stderr.
  console.error(error instanceof RecipeError ? error.message : "Local deployment setup failed; check file access and Node compatibility. No secret values are displayed.");
  process.exitCode = 1;
});
