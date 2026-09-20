#!/usr/bin/env node
/**
 * Maintainer connected TUI/Web runner.
 *
 * Copies the real OpenCode config into a 0700 temp directory, rewrites only
 * OpenCode Quota plugin entries to this worktree's dist file URLs, and launches
 * real `opencode`. The real config is never edited. The temp copy is deleted
 * on exit, on prepare/copy/transform failure, and after forwarded signals.
 * After SIGINT/SIGTERM/SIGHUP, the child gets a bounded grace period and is
 * then force-terminated (process group where safe) so cleanup cannot wait forever.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "comment-json";
import { xdgConfig } from "xdg-basedir";

export const CONNECTED_TEMP_PREFIX = "opencode-quota-stabilization-";
export const FORWARD_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);
export const CONNECTED_SIGNAL_GRACE_MS = 2_000;
export const CONNECTED_CREDENTIAL_WARNING =
  "WARNING: This connected run uses your real OpenCode credentials, quota, and provider API calls. The real config is not modified. A temporary copy is used and deleted on exit.";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const TUI_SCHEMA_URL = "https://opencode.ai/tui.json";

export function getConnectedUsage() {
  return `Usage:
  node scripts/test-stabilization-connected.mjs --tui [--prompt-bar] [--dry-run]
  node scripts/test-stabilization-connected.mjs --web [--dry-run]
  node scripts/test-stabilization-connected.mjs --help

Copies $OPENCODE_CONFIG_DIR (or the default OpenCode config dir) into a 0700 temp
directory, points only OpenCode Quota plugin entries at this worktree's dist files,
enables sidebar/toast/compact, and launches real opencode. Never edits the real config.

TUI launches with the prompt bar off. After the first TUI exits, the script offers a
second session with the prompt bar on. Use --prompt-bar to skip the first stage.
Web launches opencode web.

This uses real credentials and makes real quota/API calls.`;
}

export function parseConnectedArgs(argv) {
  const args = { mode: null, promptBar: false, dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--tui") {
      if (args.mode && args.mode !== "tui") {
        throw new Error("Choose only one of --tui or --web.");
      }
      args.mode = "tui";
      continue;
    }
    if (arg === "--web") {
      if (args.mode && args.mode !== "web") {
        throw new Error("Choose only one of --tui or --web.");
      }
      args.mode = "web";
      continue;
    }
    if (arg === "--prompt-bar") {
      args.promptBar = true;
      continue;
    }
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${getConnectedUsage()}`);
  }
  if (args.help) return args;
  if (!args.mode) {
    throw new Error(`Specify --tui or --web.\n\n${getConnectedUsage()}`);
  }
  if (args.promptBar && args.mode !== "tui") {
    throw new Error("--prompt-bar is only valid with --tui.");
  }
  return args;
}

export function connectedLaunchArgs(mode) {
  return mode === "web" ? ["web"] : [];
}

export function signalExitCode(signal) {
  const number = osConstants.signals[signal];
  return typeof number === "number" ? 128 + number : 130;
}

export function resolveSourceConfigDir(env = process.env, home = homedir()) {
  const configBase = env.XDG_CONFIG_HOME?.trim() || xdgConfig || path.join(home, ".config");
  const defaultDir = path.join(configBase, "opencode");
  const configured = env.OPENCODE_CONFIG_DIR?.trim();
  if (!configured) return defaultDir;
  return path.isAbsolute(configured) ? configured : path.resolve(defaultDir, configured);
}

export function findExecutable(name, env = process.env) {
  const pathEnv = env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function findOpenCodeExecutable(env = process.env) {
  return findExecutable("opencode", env);
}

export function pluginFileUrls(root = repoRoot) {
  return {
    server: pathToFileURL(path.resolve(root, "dist", "index.js")).href,
    tui: pathToFileURL(path.resolve(root, "dist", "tui.js")).href,
  };
}

export function getPluginSpecFromEntry(entry) {
  const spec =
    typeof entry === "string"
      ? entry
      : Array.isArray(entry) && typeof entry[0] === "string"
        ? entry[0]
        : null;
  if (typeof spec !== "string") return null;
  const trimmed = spec.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isQuotaPluginSpec(spec) {
  const normalized = spec.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("@slkiser/opencode-quota")) return true;
  if (normalized.includes("opencode-quota/dist/index.js")) return true;
  if (normalized.includes("opencode-quota/dist/tui.js")) return true;
  if (normalized.includes("opencode-quota/dist/tui.tsx")) return true;
  return normalized.includes("/opencode-quota") && !normalized.includes("/opencode-quota/dist/");
}

export function rewritePluginList(list, fileUrl) {
  let found = false;
  const next = [];
  for (const entry of list) {
    const spec = getPluginSpecFromEntry(entry);
    if (spec && isQuotaPluginSpec(spec)) {
      if (!found) {
        if (typeof entry === "string") next.push(fileUrl);
        else if (Array.isArray(entry)) next.push([fileUrl, ...entry.slice(1)]);
        else next.push(fileUrl);
        found = true;
      }
      continue;
    }
    next.push(entry);
  }
  if (!found) next.push(fileUrl);
  return next;
}

function ensureObject(parent, key) {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current;
  }
  parent[key] = {};
  return parent[key];
}

export function applyQuotaSurfaceSettings(config, options) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Quota settings must be a JSON object.");
  }
  const promptBarEnabled = Boolean(options?.promptBarEnabled);
  config.enableToast = true;
  ensureObject(config, "tuiSidebarPanel").enabled = true;
  ensureObject(config, "tuiCompactStatus").enabled = true;
  ensureObject(config, "tuiPromptBar").enabled = promptBarEnabled;
  return config;
}

function stringifyJsonc(data) {
  const rendered = stringify(data, null, 2);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function resolveExistingConfigFile(dir, kind) {
  const jsoncPath = path.join(dir, `${kind}.jsonc`);
  const jsonPath = path.join(dir, `${kind}.json`);
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return null;
}

function resolveQuotaSettingsPath(dir) {
  const jsoncPath = path.join(dir, "opencode-quota", "quota-toast.jsonc");
  const jsonPath = path.join(dir, "opencode-quota", "quota-toast.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

async function readJsoncFile(filePath) {
  const content = await readFile(filePath, "utf8");
  try {
    return parse(content);
  } catch {
    throw new Error(`Failed to parse copied ${path.basename(filePath)}.`);
  }
}

async function writeJsoncFile(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, stringifyJsonc(data), { encoding: "utf8", mode: 0o600 });
}

function assertPluginArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`Cannot update ${label} because plugin is not an array.`);
  }
  return value;
}

export async function assertOpenCodeConfigDir(sourceConfigDir) {
  const sourceStat = await stat(sourceConfigDir).catch(() => null);
  if (!sourceStat || !sourceStat.isDirectory()) {
    throw new Error(`OpenCode config directory is missing: ${sourceConfigDir}`);
  }
  if (!resolveExistingConfigFile(sourceConfigDir, "opencode")) {
    throw new Error(
      `OpenCode config is missing opencode.json or opencode.jsonc in ${sourceConfigDir}`,
    );
  }
}

export async function transformCopiedConfigDir(configDir, options) {
  const urls = pluginFileUrls(options.repoRoot ?? repoRoot);
  const promptBarEnabled = Boolean(options.promptBarEnabled);
  const ensureTuiConfig = Boolean(options.ensureTuiConfig);

  const mainPath = resolveExistingConfigFile(configDir, "opencode");
  if (!mainPath) {
    throw new Error("Copied OpenCode config is missing opencode.json or opencode.jsonc.");
  }

  const main = await readJsoncFile(mainPath);
  if (!main || typeof main !== "object" || Array.isArray(main)) {
    throw new Error("Copied opencode config must be a JSON object.");
  }
  if (!Object.hasOwn(main, "plugin")) {
    main.plugin = [];
  }
  main.plugin = rewritePluginList(assertPluginArray(main.plugin, "opencode plugin"), urls.server);
  if (
    main.tui &&
    typeof main.tui === "object" &&
    !Array.isArray(main.tui) &&
    "plugin" in main.tui
  ) {
    main.tui.plugin = rewritePluginList(
      assertPluginArray(main.tui.plugin, "opencode tui.plugin"),
      urls.tui,
    );
  }
  await writeJsoncFile(mainPath, main);

  let tuiPath = resolveExistingConfigFile(configDir, "tui");
  if (!tuiPath && ensureTuiConfig) {
    tuiPath = path.join(configDir, "tui.jsonc");
    await writeJsoncFile(tuiPath, {
      $schema: TUI_SCHEMA_URL,
      plugin: [urls.tui],
    });
  } else if (tuiPath) {
    const tui = await readJsoncFile(tuiPath);
    if (!tui || typeof tui !== "object" || Array.isArray(tui)) {
      throw new Error("Copied tui config must be a JSON object.");
    }
    if (!Object.hasOwn(tui, "plugin")) {
      tui.plugin = [];
    }
    tui.plugin = rewritePluginList(assertPluginArray(tui.plugin, "tui plugin"), urls.tui);
    await writeJsoncFile(tuiPath, tui);
  }

  const quotaPath = resolveQuotaSettingsPath(configDir);
  let quota = existsSync(quotaPath) ? await readJsoncFile(quotaPath) : {};
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) {
    quota = {};
  }
  applyQuotaSurfaceSettings(quota, { promptBarEnabled });
  await writeJsoncFile(quotaPath, quota);

  return { mainPath, tuiPath, quotaPath, urls };
}

async function walkCopiedTree(destDir, onEntry) {
  const entries = await readdir(destDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(destDir, entry.name);
    await onEntry(fullPath, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await walkCopiedTree(fullPath, onEntry);
    }
  }
}

export async function assertCopiedConfigIsolated(sourceDir, destDir) {
  const sourceReal = await realpath(sourceDir);
  await walkCopiedTree(destDir, async (fullPath, entry) => {
    if (entry.isSymbolicLink()) {
      throw new Error(`Copied config still contains a symlink (${entry.name}).`);
    }
    if (!entry.isFile()) return;
    const real = await realpath(fullPath);
    if (real === sourceReal || real.startsWith(`${sourceReal}${path.sep}`)) {
      throw new Error("Copied config is not isolated from the real config directory.");
    }
  });
}

export async function tightenCopiedPermissions(rootDir) {
  await chmod(rootDir, 0o700);
  await walkCopiedTree(rootDir, async (fullPath, entry) => {
    if (entry.isSymbolicLink()) {
      throw new Error(`Copied config still contains a symlink (${entry.name}).`);
    }
    if (entry.isDirectory()) {
      await chmod(fullPath, 0o700);
      return;
    }
    if (entry.isFile()) {
      await chmod(fullPath, 0o600);
    }
  });
}

export async function copyConfigDirIsolated(sourceDir, destDir) {
  await cp(sourceDir, destDir, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
  await assertCopiedConfigIsolated(sourceDir, destDir);
  await tightenCopiedPermissions(destDir);
}

function isStrictPathInside(inner, outer) {
  const base = outer.endsWith(path.sep) ? outer : `${outer}${path.sep}`;
  return inner.startsWith(base);
}

export function isGuardedConnectedTempPath(
  resolvedTempRoot,
  resolvedTmpdir,
  prefix = CONNECTED_TEMP_PREFIX,
) {
  if (!resolvedTempRoot || !resolvedTmpdir) return false;
  if (resolvedTempRoot === resolvedTmpdir) return false;
  if (!isStrictPathInside(resolvedTempRoot, resolvedTmpdir)) return false;
  return path.basename(resolvedTempRoot).startsWith(prefix);
}

export async function prepareConnectedWorkspace(options) {
  const sourceConfigDir = options.sourceConfigDir;
  await assertOpenCodeConfigDir(sourceConfigDir);

  const tmpdirBase = options.tmpdir ?? tmpdir();
  let tempRoot;
  try {
    tempRoot = options.tempRoot ?? (await mkdtemp(path.join(tmpdirBase, CONNECTED_TEMP_PREFIX)));
    await chmod(tempRoot, 0o700);
    const configDir = path.join(tempRoot, "config");
    const projectDir = path.join(tempRoot, "project");
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    await chmod(projectDir, 0o700);
    await copyConfigDirIsolated(sourceConfigDir, configDir);
    const transformed = await transformCopiedConfigDir(configDir, {
      repoRoot: options.repoRoot ?? repoRoot,
      promptBarEnabled: Boolean(options.promptBarEnabled),
      ensureTuiConfig: options.ensureTuiConfig !== false,
    });
    await tightenCopiedPermissions(tempRoot);
    return { tempRoot, configDir, projectDir, sourceConfigDir, tmpdir: tmpdirBase, ...transformed };
  } catch (error) {
    if (tempRoot) {
      await cleanupConnectedWorkspace(tempRoot, { tmpdir: tmpdirBase }).catch(() => undefined);
    }
    throw error;
  }
}

export async function cleanupConnectedWorkspace(tempRoot, options = {}) {
  if (!tempRoot) return;
  const tmpdirBase = options.tmpdir ?? tmpdir();
  let resolvedTempRoot;
  let resolvedTmpdir;
  try {
    resolvedTempRoot = await realpath(tempRoot);
    resolvedTmpdir = await realpath(tmpdirBase);
  } catch {
    return;
  }
  if (!isGuardedConnectedTempPath(resolvedTempRoot, resolvedTmpdir)) {
    throw new Error("Refusing to delete a path outside the expected stabilization temp directory.");
  }
  await rm(resolvedTempRoot, { recursive: true, force: true });
}

function resolvePnpmCommand(root = repoRoot, env = process.env) {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, "run", "build"] };
  }
  const localName = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const localBin = path.join(root, "node_modules", ".bin", localName);
  if (existsSync(localBin)) {
    return { command: localBin, args: ["run", "build"] };
  }
  const fromPath = findExecutable("pnpm", env);
  if (fromPath) return { command: fromPath, args: ["run", "build"] };
  throw new Error("pnpm is not available. Run this script from the repo with pnpm installed.");
}

function attachSignalForwarder(source, handler) {
  const attached = [];
  for (const signal of FORWARD_SIGNALS) {
    const onSignal = () => {
      handler(signal);
    };
    try {
      source.on(signal, onSignal);
      attached.push([signal, onSignal]);
    } catch {
      // Unsupported on this platform.
    }
  }
  return () => {
    for (const [signal, onSignal] of attached) {
      source.off(signal, onSignal);
    }
  };
}

function isChildAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function signalChild(child, signal, processGroup) {
  if (!isChildAlive(child) || !child.pid) return;
  if (processGroup && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to a direct child signal if the process group is gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    try {
      child.kill();
    } catch {
      // already exited
    }
  }
}

const childStopTimers = new WeakMap();

export function clearChildStopTimer(child) {
  const timer = childStopTimers.get(child);
  if (!timer) return;
  clearTimeout(timer);
  childStopTimers.delete(child);
}

export function stopChild(child, signal, options = {}) {
  if (!isChildAlive(child)) return;
  const graceMs = options.graceMs ?? CONNECTED_SIGNAL_GRACE_MS;
  const processGroup = options.processGroup ?? process.platform !== "win32";
  signalChild(child, signal, processGroup);
  if (childStopTimers.has(child)) return;
  const timer = setTimeout(() => {
    childStopTimers.delete(child);
    signalChild(child, "SIGKILL", processGroup);
  }, graceMs);
  childStopTimers.set(child, timer);
}

function killChild(child, signal, options = {}) {
  stopChild(child, signal, options);
}

export function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? "inherit",
      shell: false,
      detached: processGroup,
    });
    const graceMs = options.signalGraceMs ?? CONNECTED_SIGNAL_GRACE_MS;
    options.onSpawn?.(child);
    const signalSource = options.signalSource ?? process;
    const detach = attachSignalForwarder(signalSource, (signal) => {
      stopChild(child, signal, { graceMs, processGroup });
    });
    child.on("error", (error) => {
      clearChildStopTimer(child);
      detach();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearChildStopTimer(child);
      detach();
      resolve({ code, signal });
    });
  });
}

export function buildConnectedChildEnv(env, configDir) {
  const childEnv = {
    ...env,
    OPENCODE_CONFIG_DIR: configDir,
  };
  delete childEnv.OPENCODE_CONFIG;
  return childEnv;
}

async function confirmPromptBarStage(stdio) {
  const input = stdio?.stdin ?? process.stdin;
  const output = stdio?.stdout ?? process.stdout;
  if (!input.isTTY || !output.isTTY) {
    output.write(
      "Skipping prompt-bar stage because this session is not a TTY. Re-run with --prompt-bar.\n",
    );
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (
      await rl.question("Launch a second TUI session with the prompt bar enabled? [Y/n] ")
    )
      .trim()
      .toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function printPlan(options) {
  const stream = options.stderr ?? process.stderr;
  stream.write(`${CONNECTED_CREDENTIAL_WARNING}\n`);
  stream.write(`Mode: ${options.mode}${options.promptBarEnabled ? " (prompt bar enabled)" : ""}\n`);
  stream.write(`Source config dir: ${options.sourceConfigDir}\n`);
  stream.write(`OpenCode: ${options.opencodeBin}\n`);
  stream.write(`Server plugin: ${options.urls.server}\n`);
  stream.write(`TUI plugin: ${options.urls.tui}\n`);
  if (options.configDir) stream.write(`Temp config dir: ${options.configDir}\n`);
  if (options.projectDir) stream.write(`Temp project dir: ${options.projectDir}\n`);
}

export async function runConnected(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  let args;
  try {
    args = parseConnectedArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (args.help) {
    stdout.write(`${getConnectedUsage()}\n`);
    return 0;
  }

  const sourceConfigDir = resolveSourceConfigDir(env);
  try {
    await assertOpenCodeConfigDir(sourceConfigDir);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const opencodeBin = findOpenCodeExecutable(env);
  if (!opencodeBin) {
    stderr.write("OpenCode executable was not found on PATH.\n");
    return 1;
  }
  const urls = pluginFileUrls(io.repoRoot ?? repoRoot);

  if (args.dryRun) {
    printPlan({
      mode: args.mode,
      promptBarEnabled: args.promptBar,
      sourceConfigDir,
      opencodeBin,
      urls,
      stderr,
    });
    stderr.write("Dry run: no temp copy, build, or OpenCode launch.\n");
    return 0;
  }

  const tmpdirBase = io.tmpdir ?? tmpdir();
  const signalGraceMs = io.signalGraceMs ?? CONNECTED_SIGNAL_GRACE_MS;
  let workspace;
  let cleaned = false;
  let activeChild = null;
  let interruptSignal = null;
  const cleanup = async () => {
    if (cleaned || !workspace) return;
    cleaned = true;
    await cleanupConnectedWorkspace(workspace.tempRoot, {
      tmpdir: workspace.tmpdir ?? tmpdirBase,
    });
  };
  const onSignal = (signal) => {
    interruptSignal = signal;
    killChild(activeChild, signal, { graceMs: signalGraceMs });
  };
  const detachSignals = attachSignalForwarder(process, onSignal);

  try {
    const pnpm = resolvePnpmCommand(io.repoRoot ?? repoRoot, env);
    const build = await runProcess(pnpm.command, pnpm.args, {
      cwd: io.repoRoot ?? repoRoot,
      env,
      signalGraceMs,
      onSpawn(child) {
        activeChild = child;
      },
    });
    activeChild = null;
    if (interruptSignal) {
      await cleanup();
      return signalExitCode(interruptSignal);
    }
    if (build.code !== 0) return build.code ?? 1;
    if (!existsSync(path.resolve(io.repoRoot ?? repoRoot, "dist", "index.js"))) {
      stderr.write("Build did not produce dist/index.js.\n");
      return 1;
    }
    if (
      args.mode === "tui" &&
      !existsSync(path.resolve(io.repoRoot ?? repoRoot, "dist", "tui.js"))
    ) {
      stderr.write("Build did not produce dist/tui.js.\n");
      return 1;
    }

    workspace = await prepareConnectedWorkspace({
      sourceConfigDir,
      repoRoot: io.repoRoot ?? repoRoot,
      promptBarEnabled: args.promptBar,
      ensureTuiConfig: args.mode === "tui",
      tmpdir: tmpdirBase,
    });
    if (interruptSignal) {
      await cleanup();
      return signalExitCode(interruptSignal);
    }
    printPlan({
      mode: args.mode,
      promptBarEnabled: args.promptBar,
      sourceConfigDir,
      opencodeBin,
      urls: workspace.urls,
      configDir: workspace.configDir,
      projectDir: workspace.projectDir,
      stderr,
    });

    const childEnv = buildConnectedChildEnv(env, workspace.configDir);
    const launchArgs = connectedLaunchArgs(args.mode);
    const first = await runProcess(opencodeBin, launchArgs, {
      cwd: workspace.projectDir,
      env: childEnv,
      signalGraceMs,
      onSpawn(child) {
        activeChild = child;
      },
    });
    activeChild = null;
    if (interruptSignal) {
      await cleanup();
      return signalExitCode(interruptSignal);
    }
    if (args.mode === "tui" && !args.promptBar && first.signal == null && first.code === 0) {
      const shouldLaunchPromptBar = await confirmPromptBarStage({
        stdin: io.stdin ?? process.stdin,
        stdout,
      });
      if (interruptSignal) {
        await cleanup();
        return signalExitCode(interruptSignal);
      }
      if (shouldLaunchPromptBar) {
        await transformCopiedConfigDir(workspace.configDir, {
          repoRoot: io.repoRoot ?? repoRoot,
          promptBarEnabled: true,
          ensureTuiConfig: true,
        });
        await tightenCopiedPermissions(workspace.tempRoot);
        stderr.write("Launching second TUI session with the prompt bar enabled.\n");
        const second = await runProcess(opencodeBin, [], {
          cwd: workspace.projectDir,
          env: childEnv,
          signalGraceMs,
          onSpawn(child) {
            activeChild = child;
          },
        });
        activeChild = null;
        await cleanup();
        if (interruptSignal) return signalExitCode(interruptSignal);
        return second.code ?? (second.signal ? 1 : 0);
      }
    }
    await cleanup();
    return first.code ?? (first.signal ? 1 : 0);
  } catch (error) {
    await cleanup();
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    detachSignals();
    await cleanup();
  }
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const code = await runConnected(process.argv.slice(2));
  process.exit(code);
}
