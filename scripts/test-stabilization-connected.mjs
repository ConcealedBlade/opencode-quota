#!/usr/bin/env node
/**
 * Maintainer connected TUI/Web runner.
 *
 * Copies the real OpenCode config into a 0700 temp directory, rewrites only
 * OpenCode Quota plugin entries to this worktree's dist file URLs, and launches
 * real `opencode`. The real config is never edited. The temp copy is deleted
 * on exit, on prepare/copy/transform failure, and after forwarded signals.
 * Web mode keeps a separate sanitized diagnostics file for that run only.
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
  open,
  opendir,
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
The prompt bar is a fixed 12-cell bar. Check provider identity and placement/clipping
on terminal resize; the bar does not grow with the terminal.
Web launches opencode web after checking the temp copy's default model against
the fixed opencode models command in that same temp environment. It never sends a
model request. If the model is stale, only the temp copy is rewritten. If a safe
model cannot be chosen, the runner exits before launch with click/select guidance.
Web writes bounded, sanitized diagnostics for this run only. Diagnostic capture is
best-effort and cannot change the Web child exit result.

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

export const OPENCODE_MODELS_ARGS = Object.freeze(["models"]);
export const CONNECTED_WEB_COMMANDS = Object.freeze(["/quota", "/quota_status"]);
export const WEB_DIAGNOSTICS_TEMP_PREFIX = "opencode-quota-web-diagnostics-";
export const WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK = "invalid-model-before-hook";
export const WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION = "hook-entry-build-injection-failure";
export const WEB_FAILURE_POST_INJECTION_BUSY_272 = "post-injection-busy-272";
export const WEB_FAILURE_UNKNOWN = "unknown-unclassified";
export const WEB_DIAGNOSTIC_SOURCE_MAX_BYTES = 64 * 1024;
export const WEB_DIAGNOSTIC_LOG_MAX_BYTES = 128 * 1024;
export const WEB_DIAGNOSTIC_TOTAL_MAX_BYTES = 256 * 1024;
export const WEB_DIAGNOSTIC_MAX_LOG_FILES = 32;
export const CAPTURED_PROCESS_STREAM_MAX_BYTES = 256 * 1024;
export const DIAGNOSTIC_TRUNCATED_MARKER = "\n[TRUNCATED: diagnostic byte limit reached]\n";
export const DIAGNOSTIC_REDACTED_HEADER_MARKER = "[REDACTED_HEADER]";
export const DIAGNOSTIC_REDACTED_BODY_MARKER = "[REDACTED_BODY]";
export const DIAGNOSTIC_REDACTED_CONFIG_MARKER = "[REDACTED_CONFIG]";
export const DIAGNOSTIC_REDACTED_PRIVATE_MARKER = "[REDACTED_PRIVATE]";

const MODEL_REQUEST_COMMANDS = new Set(["run", "generate", "prompt"]);
const ANSI_COLOR_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function assertNoModelRequest(args) {
  for (const arg of args) {
    if (MODEL_REQUEST_COMMANDS.has(arg)) {
      throw new Error("Refusing to send a model request from the connected Web runner.");
    }
  }
  return args;
}

export function normalizeConfiguredModel(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider =
    typeof value.providerID === "string"
      ? value.providerID.trim()
      : typeof value.providerId === "string"
        ? value.providerId.trim()
        : "";
  const id =
    typeof value.modelID === "string"
      ? value.modelID.trim()
      : typeof value.id === "string"
        ? value.id.trim()
        : "";
  if (provider && id) return `${provider}/${id}`;
  if (id.includes("/")) return id;
  return null;
}

function compareModelIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function isModelId(value) {
  return typeof value === "string" && value.includes("/") && !value.includes("://");
}

export function uniqueSortedModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    const id = typeof model === "string" ? model.trim() : model?.id?.trim();
    if (!isModelId(id) || (typeof model === "object" && model?.usability !== "usable")) {
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort(compareModelIds);
  return out;
}

function structuredModelId(value, inheritedProvider) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const provider =
    typeof value.providerID === "string"
      ? value.providerID.trim()
      : typeof value.providerId === "string"
        ? value.providerId.trim()
        : typeof value.provider === "string"
          ? value.provider.trim()
          : inheritedProvider;
  const rawId =
    typeof value.modelID === "string"
      ? value.modelID.trim()
      : typeof value.modelId === "string"
        ? value.modelId.trim()
        : typeof value.id === "string"
          ? value.id.trim()
          : "";
  if (rawId.includes("/")) return rawId;
  return provider && rawId ? `${provider}/${rawId}` : null;
}

function structuredModelUsability(value) {
  const positiveStates = new Set(["available", "enabled", "active", "ready", "online"]);
  const negativeStates = new Set([
    "alias",
    "disabled",
    "hidden",
    "unavailable",
    "offline",
    "removed",
  ]);
  const alias =
    value.alias === true ||
    typeof value.alias === "string" ||
    typeof value.aliasOf === "string" ||
    typeof value.targetModel === "string";
  if (alias) return "rejected";

  let usable = false;
  let unknown = false;
  for (const key of ["status", "availability", "state"]) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "string") {
      unknown = true;
      continue;
    }
    const state = value[key].trim().toLowerCase();
    if (negativeStates.has(state)) return "rejected";
    if (positiveStates.has(state)) usable = true;
    else unknown = true;
  }

  for (const [key, positive, negative] of [
    ["available", true, false],
    ["enabled", true, false],
    ["disabled", false, true],
    ["hidden", false, true],
    ["visible", false, false],
    ["unavailable", false, true],
  ]) {
    if (!(key in value)) continue;
    if (typeof value[key] !== "boolean") {
      unknown = true;
      continue;
    }
    if (value[key] === negative) return "rejected";
    if (positive && value[key] === positive) usable = true;
  }

  for (const key of ["alias", "aliasOf", "targetModel"]) {
    if (key in value && value[key] !== false && value[key] != null) unknown = true;
  }
  return usable && !unknown ? "usable" : "unknown";
}

function extractStructuredModels(value, inheritedProvider = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractStructuredModels(item, inheritedProvider));
  }
  if (!value || typeof value !== "object") return [];
  const provider =
    typeof value.providerID === "string"
      ? value.providerID.trim()
      : typeof value.providerId === "string"
        ? value.providerId.trim()
        : typeof value.provider === "string"
          ? value.provider.trim()
          : inheritedProvider;
  const nested = [];
  for (const key of ["models", "data", "items", "all", "providers"]) {
    if (key in value) nested.push(...extractStructuredModels(value[key], provider));
  }
  const hasNestedModels = ["models", "providers"].some((key) => key in value);
  const id = hasNestedModels ? null : structuredModelId(value, inheritedProvider);
  if (!isModelId(id)) return nested;
  return [
    {
      id,
      usability: structuredModelUsability(value),
      source: "structured",
      metadata: value,
    },
    ...nested,
  ];
}

function parseWarningPrefixedJson(raw) {
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"');
  });
  if (index < 0) return { kind: "plain", value: null };
  try {
    return {
      kind: "structured",
      value: JSON.parse([lines[index].trimStart(), ...lines.slice(index + 1)].join("\n")),
    };
  } catch {
    return { kind: "malformed", value: null };
  }
}

export function parseOpenCodeModelsOutput(text) {
  const raw = limitDiagnosticText(String(text), CAPTURED_PROCESS_STREAM_MAX_BYTES).replace(
    ANSI_COLOR_PATTERN,
    "",
  );
  const structured = parseWarningPrefixedJson(raw);
  if (structured.kind === "structured") return extractStructuredModels(structured.value);
  if (structured.kind === "malformed") return [];

  const models = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(ANSI_COLOR_PATTERN, "").trim();
    if (!trimmed || trimmed.startsWith("#") || /^warn(?:ing)?\b/i.test(trimmed)) continue;
    const [token, ...metadataParts] = trimmed.split(/\s+/);
    if (!isModelId(token)) continue;
    const metadataText = metadataParts.join(" ").trim();
    const normalizedMetadata = metadataText.toLowerCase();
    const rejected = /\b(?:alias|disabled|hidden|unavailable|offline|removed)\b/.test(
      normalizedMetadata,
    );
    const explicitlyUsable = /\b(?:available|enabled|active|ready|online)\b/.test(
      normalizedMetadata,
    );
    models.push({
      id: token,
      usability: rejected ? "rejected" : !metadataText || explicitlyUsable ? "usable" : "unknown",
      source: "plain",
      metadata: metadataText || null,
    });
  }
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

export function chooseConnectedWebModel(originalModel, catalog) {
  const models = uniqueSortedModels(catalog);
  if (models.length === 0) return { status: "empty-catalog", model: null };
  if (originalModel && models.includes(originalModel)) {
    return { status: "keep", model: originalModel };
  }
  if (originalModel && !originalModel.includes("/")) {
    const qualified = models.find((id) => id.endsWith(`/${originalModel}`));
    if (qualified) return { status: "replace", model: qualified };
  }
  let chosen = models[0];
  if (originalModel?.includes("/")) {
    const provider = originalModel.slice(0, originalModel.indexOf("/"));
    const sameProvider = models.filter((id) => id.startsWith(`${provider}/`));
    if (sameProvider.length > 0) chosen = sameProvider[0];
  }
  return { status: "replace", model: chosen };
}

export function formatModelLabel(model) {
  return model ?? "(unset)";
}

export function formatWebModelChoice(result) {
  return [
    `Copied default model: ${formatModelLabel(result.originalModel)}`,
    `Temporary Web model: ${formatModelLabel(result.temporaryModel)}`,
  ].join("\n");
}

export function formatConnectedWebModelGuidance(options) {
  const original = formatModelLabel(options.originalModel);
  const catalog = uniqueSortedModels(options.catalog ?? []);
  const lines = [
    "Connected Web preflight refused to launch because the temp default model is not a currently available connected model.",
    `Copied default model: ${original}`,
    "The real OpenCode config was not edited.",
    "OpenCode Web validates the session model before /quota and /quota_status plugin hooks run.",
  ];
  if (options.reason === "models-command-failed") {
    lines.push(
      "Could not list models with the fixed OpenCode command `opencode models` (no shell, no model request).",
    );
    if (options.detail) lines.push(redactConnectedDiagnostics(String(options.detail)));
  } else if (options.reason === "empty-catalog") {
    lines.push("The model catalog for this temp OpenCode environment is empty.");
  } else if (options.reason === "unusable-catalog") {
    lines.push("The model catalog did not contain a non-alias model with explicit usable status.");
  }
  lines.push("To continue this Web check:");
  lines.push(
    "1. Click the model name in the OpenCode Web session header to open the model selector.",
  );
  if (catalog.length > 0) {
    lines.push("2. Select one of these currently available models:");
    for (const model of catalog) lines.push(`   - ${model}`);
  } else {
    lines.push(
      "2. Authenticate a connected provider, then reopen the model selector and choose an available model.",
    );
  }
  lines.push(`3. Run ${CONNECTED_WEB_COMMANDS[0]}.`);
  lines.push(`4. Run ${CONNECTED_WEB_COMMANDS[1]}.`);
  lines.push("Do not send a chat prompt or other model request.");
  return lines.join("\n");
}

export function limitDiagnosticText(text, maxBytes, marker = DIAGNOSTIC_TRUNCATED_MARKER) {
  const input = Buffer.from(String(text), "utf8");
  if (input.length <= maxBytes) return input.toString("utf8");
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes <= markerBytes) return Buffer.from(marker).subarray(0, maxBytes).toString("utf8");
  const contentBytes = maxBytes - markerBytes;
  let end = contentBytes;
  let prefix = input.subarray(0, end).toString("utf8");
  while (Buffer.byteLength(prefix) > contentBytes && end > 0) {
    end -= 1;
    prefix = input.subarray(0, end).toString("utf8");
  }
  return `${prefix}${marker}`;
}

export function appendBoundedDiagnostic(current, chunk, maxBytes) {
  if (current.endsWith(DIAGNOSTIC_TRUNCATED_MARKER)) return current;
  return limitDiagnosticText(`${current}${String(chunk)}`, maxBytes);
}

function diagnosticRedactionForLine(line) {
  const patterns = [
    [
      /^\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*:|["']?(?:headers?|cookies?|set-cookie)["']?\s*[:=]/i,
      DIAGNOSTIC_REDACTED_HEADER_MARKER,
    ],
    [
      /["']?(?:(?:request|response)\s*(?:body|payload|content)|request_body|response_body|requestBody|responseBody)["']?\s*[:=]/i,
      DIAGNOSTIC_REDACTED_BODY_MARKER,
    ],
    [
      /["']?(?:serialized\s+)?(?:opencode\s+)?config(?:uration)?(?:\s+contents?)?["']?\s*[:=]/i,
      DIAGNOSTIC_REDACTED_CONFIG_MARKER,
    ],
    [/private\s+(?:data|content|message|reply)\s*[:=]/i, DIAGNOSTIC_REDACTED_PRIVATE_MARKER],
  ];
  for (const [pattern, marker] of patterns) {
    const match = pattern.exec(line);
    if (match) {
      return { marker, value: line.slice(match.index + match[0].length).trimStart() };
    }
  }
  return null;
}

function scanDiagnosticDelimitedValue(text, state = { stack: [], quote: null, escaped: false }) {
  for (const character of text) {
    if (state.quote) {
      if (state.escaped) state.escaped = false;
      else if (character === "\\") state.escaped = true;
      else if (character === state.quote) state.quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      state.quote = character;
      continue;
    }
    if (character === "{" || character === "[") {
      state.stack.push(character);
      continue;
    }
    if (character !== "}" && character !== "]") continue;
    const expected = character === "}" ? "{" : "[";
    if (state.stack.pop() !== expected) return { complete: false, invalid: true, state };
    if (state.stack.length === 0) return { complete: true, invalid: false, state };
  }
  return { complete: false, invalid: false, state };
}

export function redactConnectedDiagnostics(text) {
  let out = String(text);
  out = out.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    DIAGNOSTIC_REDACTED_PRIVATE_MARKER,
  );
  let blockState = null;
  let pendingBlock = false;
  let redactRemainder = false;
  out = out
    .split(/\r?\n/)
    .map((line) => {
      if (redactRemainder) return "";
      if (blockState) {
        const scanned = scanDiagnosticDelimitedValue(line, blockState);
        if (scanned.complete) blockState = null;
        else if (scanned.invalid) redactRemainder = true;
        return "";
      }
      if (pendingBlock) {
        if (!line.trim()) return "";
        pendingBlock = false;
        const value = line.trimStart();
        if (!value.startsWith("{") && !value.startsWith("[")) {
          redactRemainder = true;
          return "";
        }
        const scanned = scanDiagnosticDelimitedValue(value);
        if (!scanned.complete) {
          if (scanned.invalid) redactRemainder = true;
          else blockState = scanned.state;
        }
        return "";
      }

      const redaction = diagnosticRedactionForLine(line);
      if (!redaction) return line;
      const { marker, value } = redaction;
      if (!value) pendingBlock = true;
      else if (value.startsWith("{") || value.startsWith("[")) {
        const scanned = scanDiagnosticDelimitedValue(value);
        if (!scanned.complete) {
          if (scanned.invalid) redactRemainder = true;
          else blockState = scanned.state;
        }
      } else if (marker === DIAGNOSTIC_REDACTED_BODY_MARKER) {
        redactRemainder = true;
      }
      return marker;
    })
    .join("\n");
  out = out.replace(/\bBearer\s+[^\s,"']+/gi, "Bearer [REDACTED]");
  out = out.replace(/\bBasic\s+[^\s,"']+/gi, "Basic [REDACTED]");
  const sensitiveKey =
    "(?:authorization|x-api-key|api[-_]?key|client[-_]?secret|(?:access|refresh|id|auth)[-_]?token|password|secret|token|session|credential|cookie|set-cookie)";
  out = out.replace(
    new RegExp(
      String.raw`(["']?${sensitiveKey}["']?\s*[:=]\s*)"(?:\\[^\r\n]|[^"\\\r\n])*(?:"|$)`,
      "gim",
    ),
    '$1"[REDACTED]"',
  );
  out = out.replace(
    new RegExp(
      String.raw`(["']?${sensitiveKey}["']?\s*[:=]\s*)'(?:\\[^\r\n]|[^'\\\r\n])*(?:'|$)`,
      "gim",
    ),
    "$1'[REDACTED]'",
  );
  out = out.replace(
    new RegExp(`(["']?${sensitiveKey}["']?\\s*[:=]\\s*)([^\\s,}\\r\\n"']+)`, "gi"),
    "$1[REDACTED]",
  );
  out = out.replace(
    /([?&](?:access_token|refresh_token|api[_-]?key|token|key|secret)=)[^&#\s]+/gi,
    "$1[REDACTED]",
  );
  return out;
}

function firstMarkerIndex(text, pattern, fromIndex = 0) {
  const match = pattern.exec(text.slice(fromIndex));
  return match ? fromIndex + match.index : -1;
}

function firstAffirmativeMarkerIndex(text, pattern, fromIndex = 0) {
  let offset = fromIndex;
  for (const line of text.slice(fromIndex).split(/\r?\n/)) {
    const match = pattern.exec(line);
    const prefix = match ? line.slice(0, match.index) : "";
    const negated =
      /\b(?:not|never|no|without|failed to|did not|could not|cannot)(?:\s+\w+){0,2}\s*$/i.test(
        prefix,
      );
    const suffix = match ? line.slice(match.index + match[0].length) : "";
    const assignment = /^\s*["']?\s*[:=]\s*(.*)$/.exec(suffix);
    const affirmative =
      !assignment || /^(?:true|"true"|'true')(?:\s|[,;}\]]|$)/i.test(assignment[1]);
    if (match && !negated && affirmative) return offset + match.index;
    offset += line.length + 1;
  }
  return -1;
}

export function classifyWebDiagnostic(text) {
  const value = String(text);
  const hookIndex = firstMarkerIndex(
    value,
    /command\.execute\.before|handleDeterministicSlashCommand|injectRawOutput/i,
  );
  const invalidIndex = firstMarkerIndex(value, /ProviderModelNotFoundError|Model not found:/i);
  if (invalidIndex >= 0 && hookIndex < 0) return WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK;
  if (hookIndex < 0) return WEB_FAILURE_UNKNOWN;

  const hookFailureIndex = firstMarkerIndex(
    value,
    /Failed to inject raw output|Failed to build quota|quota dialog command failed/i,
    hookIndex,
  );
  if (hookFailureIndex > hookIndex) return WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION;

  const outputIndex = firstAffirmativeMarkerIndex(
    value,
    /raw output injected|injected raw output|quota output (?:ready|rendered|written)|slash command output complete/i,
    hookIndex,
  );
  const busyIndex = firstAffirmativeMarkerIndex(
    value,
    /session is busy|session busy|session-busy/i,
    outputIndex >= 0 ? outputIndex : hookIndex,
  );
  if (outputIndex > hookIndex && busyIndex > outputIndex) {
    return WEB_FAILURE_POST_INJECTION_BUSY_272;
  }
  return WEB_FAILURE_UNKNOWN;
}

export function sliceLogFromOffset(content, offset) {
  const raw = String(content);
  const start = Number(offset);
  if (!Number.isFinite(start) || start <= 0) {
    return limitDiagnosticText(raw, WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
  }
  const buf = Buffer.from(raw, "utf8");
  if (start >= buf.length) return "";
  return limitDiagnosticText(buf.subarray(start).toString("utf8"), WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
}

export function resolveOpenCodeLogDir(
  env = process.env,
  home = homedir(),
  platform = process.platform,
) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const fallback =
    platform === "darwin"
      ? platformPath.join(home, "Library", "Application Support")
      : platformPath.join(home, ".local", "share");
  const dataBase = env.XDG_DATA_HOME?.trim() || fallback;
  return platformPath.join(dataBase, "opencode", "log");
}

export function resolveOpenCodeLogDirs(
  env = process.env,
  home = homedir(),
  platform = process.platform,
) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const dirs = [resolveOpenCodeLogDir(env, home, platform)];
  if (platform === "darwin") {
    dirs.push(platformPath.join(home, "Library", "Application Support", "opencode", "log"));
  }
  return [...new Set(dirs.filter(Boolean))];
}

async function listBoundedLogFiles(logDirs) {
  const files = [];
  for (const logDir of logDirs) {
    if (files.length >= WEB_DIAGNOSTIC_MAX_LOG_FILES || !existsSync(logDir)) continue;
    let directory;
    try {
      directory = await opendir(logDir);
      for await (const entry of directory) {
        if (!entry.isFile()) continue;
        files.push(path.join(logDir, entry.name));
        if (files.length >= WEB_DIAGNOSTIC_MAX_LOG_FILES) break;
      }
    } catch {
      // Logs are optional diagnostics.
    }
  }
  return files.sort(compareModelIds);
}

export async function snapshotLogOffsets(logDirs) {
  const offsets = new Map();
  for (const filePath of await listBoundedLogFiles(logDirs)) {
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat?.isFile()) offsets.set(filePath, fileStat.size);
  }
  return offsets;
}

async function readBoundedLogSlice(filePath, offset) {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) return "";
  const requestedStart = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const start = fileStat.size < requestedStart ? 0 : requestedStart;
  if (start >= fileStat.size) return "";
  const available = fileStat.size - start;
  const truncated = available > WEB_DIAGNOSTIC_SOURCE_MAX_BYTES;
  const markerBytes = truncated ? Buffer.byteLength(DIAGNOSTIC_TRUNCATED_MARKER) : 0;
  const length = Math.min(available, WEB_DIAGNOSTIC_SOURCE_MAX_BYTES - markerBytes);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const suffix = truncated ? DIAGNOSTIC_TRUNCATED_MARKER : "";
    return limitDiagnosticText(
      `${buffer.subarray(0, bytesRead).toString("utf8")}${suffix}`,
      WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
    );
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function readNewLogRecords(logDirs, offsets) {
  let output = "";
  const currentFiles = await listBoundedLogFiles(logDirs);
  const files = [...new Set([...offsets.keys(), ...currentFiles])]
    .sort(compareModelIds)
    .slice(0, WEB_DIAGNOSTIC_MAX_LOG_FILES);
  for (const filePath of files) {
    const slice = await readBoundedLogSlice(filePath, offsets.get(filePath) ?? 0).catch(() => "");
    if (!slice.trim()) continue;
    output = appendBoundedDiagnostic(
      output,
      `=== ${path.basename(filePath)} ===\n${slice}\n`,
      WEB_DIAGNOSTIC_LOG_MAX_BYTES,
    );
    if (output.endsWith(DIAGNOSTIC_TRUNCATED_MARKER)) break;
  }
  return output;
}

export function formatWebDiagnostics(options) {
  const runner = limitDiagnosticText(
    redactConnectedDiagnostics(options.runner ?? ""),
    WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
  );
  const server = limitDiagnosticText(
    redactConnectedDiagnostics(options.server ?? ""),
    WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
  );
  const log = limitDiagnosticText(
    redactConnectedDiagnostics(options.log ?? ""),
    WEB_DIAGNOSTIC_LOG_MAX_BYTES,
  );
  const sourceClasses = [runner, server, log].map(classifyWebDiagnostic);
  const combinedHasHook =
    /command\.execute\.before|handleDeterministicSlashCommand|injectRawOutput/i.test(
      `${runner}\n${server}\n${log}`,
    );
  const observedClass = sourceClasses.includes(WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION)
    ? WEB_FAILURE_HOOK_ENTRY_BUILD_INJECTION
    : sourceClasses.includes(WEB_FAILURE_POST_INJECTION_BUSY_272)
      ? WEB_FAILURE_POST_INJECTION_BUSY_272
      : !combinedHasHook && sourceClasses.includes(WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK)
        ? WEB_FAILURE_INVALID_MODEL_BEFORE_HOOK
        : WEB_FAILURE_UNKNOWN;
  const failureClass = options.failureClass ?? observedClass;
  const content = [
    "# opencode-quota connected Web diagnostics",
    "# bounded to this run; sensitive values redacted; config contents omitted",
    `Copied default model: ${formatModelLabel(options.originalModel)}`,
    `Temporary Web model: ${formatModelLabel(options.temporaryModel)}`,
    `Failure class: ${failureClass}`,
    "",
    "## Runner",
    runner.trim() || "(empty)",
    "",
    "## Server",
    server.trim() || "(empty)",
    "",
    "## OpenCode log (new bounded records only)",
    log.trim() || "(no OpenCode log records for this run)",
    "",
  ].join("\n");
  return limitDiagnosticText(content, WEB_DIAGNOSTIC_TOTAL_MAX_BYTES);
}

export async function createWebDiagnosticsFile(options = {}) {
  const tmpdirBase = options.tmpdir ?? tmpdir();
  const dir = await mkdtemp(path.join(tmpdirBase, WEB_DIAGNOSTICS_TEMP_PREFIX));
  await chmod(dir, 0o700);
  const filePath = path.join(dir, "web-diagnostics.log");
  await writeFile(filePath, "", { encoding: "utf8", mode: 0o600 });
  return { dir, filePath };
}

export async function writeWebDiagnosticsFile(filePath, content) {
  await writeFile(
    filePath,
    limitDiagnosticText(redactConnectedDiagnostics(content), WEB_DIAGNOSTIC_TOTAL_MAX_BYTES),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(filePath, 0o600);
  return filePath;
}

export function formatWebDiagnosticsPath(filePath) {
  return `Web diagnostics (sanitized, this run only): ${filePath}`;
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
    const detach =
      options.signalSource === null
        ? () => {}
        : attachSignalForwarder(options.signalSource ?? process, (signal) => {
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

export function runCapturedProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      shell: false,
      detached: processGroup,
    });
    const graceMs = options.signalGraceMs ?? CONNECTED_SIGNAL_GRACE_MS;
    options.onSpawn?.(child);
    const detach =
      options.signalSource === null
        ? () => {}
        : attachSignalForwarder(options.signalSource ?? process, (signal) => {
            stopChild(child, signal, { graceMs, processGroup });
          });
    let stdout = "";
    let stderr = "";
    const maxCaptureBytes = options.maxCaptureBytes ?? CAPTURED_PROCESS_STREAM_MAX_BYTES;
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout = appendBoundedDiagnostic(stdout, text, maxCaptureBytes);
      options.onChunk?.("stdout", text);
      options.forward?.stdout?.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr = appendBoundedDiagnostic(stderr, text, maxCaptureBytes);
      options.onChunk?.("stderr", text);
      options.forward?.stderr?.write(text);
    });
    child.on("error", (error) => {
      clearChildStopTimer(child);
      detach();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearChildStopTimer(child);
      detach();
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export async function listOpenCodeModels(options) {
  const args = assertNoModelRequest([...OPENCODE_MODELS_ARGS]);
  const runCaptured = options.runCaptured ?? runCapturedProcess;
  const result = await runCaptured(options.opencodeBin, args, {
    cwd: options.cwd,
    env: options.env,
    signalSource: options.signalSource,
    signalGraceMs: options.signalGraceMs,
    onSpawn: options.onSpawn,
  });
  if ((result.code ?? 0) !== 0 || result.signal) {
    const detail = redactConnectedDiagnostics(
      limitDiagnosticText(
        result.stderr?.trim() ||
          result.stdout?.trim() ||
          `opencode models exited ${result.code ?? result.signal}`,
        WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
      ),
    );
    return { ok: false, args, models: [], detail, signal: result.signal ?? null };
  }
  return {
    ok: true,
    args,
    models: parseOpenCodeModelsOutput(result.stdout),
    detail: null,
    signal: null,
  };
}

export async function readCopiedDefaultModel(mainPath) {
  const main = await readJsoncFile(mainPath);
  if (!main || typeof main !== "object" || Array.isArray(main)) {
    throw new Error("Copied opencode config must be a JSON object.");
  }
  return { main, originalModel: normalizeConfiguredModel(main.model) };
}

export async function prepareConnectedWebModel(options) {
  const { main, originalModel } = await readCopiedDefaultModel(options.mainPath);
  const listed = await listOpenCodeModels({
    opencodeBin: options.opencodeBin,
    cwd: options.projectDir,
    env: buildConnectedChildEnv(options.env, options.configDir),
    runCaptured: options.runCaptured,
    signalSource: options.signalSource,
    signalGraceMs: options.signalGraceMs,
    onSpawn: options.onSpawn,
  });
  if (!listed.ok) {
    return {
      ok: false,
      reason: "models-command-failed",
      signal: listed.signal,
      originalModel,
      temporaryModel: originalModel,
      catalog: [],
      replaced: false,
      spawnedArgs: listed.args,
      guidance: formatConnectedWebModelGuidance({
        originalModel,
        catalog: [],
        reason: "models-command-failed",
        detail: listed.detail,
      }),
    };
  }
  const choice = chooseConnectedWebModel(originalModel, listed.models);
  if (choice.status === "empty-catalog") {
    const reason = listed.models.length > 0 ? "unusable-catalog" : "empty-catalog";
    return {
      ok: false,
      reason,
      signal: null,
      originalModel,
      temporaryModel: originalModel,
      catalog: listed.models,
      replaced: false,
      spawnedArgs: listed.args,
      guidance: formatConnectedWebModelGuidance({
        originalModel,
        catalog: listed.models,
        reason,
      }),
    };
  }
  if (choice.status === "replace") {
    main.model = choice.model;
    await writeJsoncFile(options.mainPath, main);
  }
  return {
    ok: true,
    reason: choice.status === "keep" ? "valid-model" : "stale-model",
    signal: null,
    originalModel,
    temporaryModel: choice.model,
    catalog: listed.models,
    replaced: choice.status === "replace",
    spawnedArgs: listed.args,
    guidance: null,
  };
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
  if (options.promptBarEnabled) {
    stream.write(
      "Prompt bar: fixed 12-cell fill. Check provider identity and placement/clipping on resize, not bar growth.\n",
    );
  }
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
  const signalSource = io.signalSource ?? process;
  const createDiagnostics = io.createWebDiagnosticsFile ?? createWebDiagnosticsFile;
  const writeDiagnostics = io.writeWebDiagnosticsFile ?? writeWebDiagnosticsFile;
  const readLogs = io.readNewLogRecords ?? readNewLogRecords;
  let workspace;
  let cleaned = false;
  let activeChild = null;
  let interruptSignal = null;
  let webDiagnostics = null;
  let webDiagnosticsFlushed = false;
  let webDiagnosticsFlushPromise = null;
  let webDiagnosticsFailureReported = false;
  let webRunner = "";
  let webServer = "";
  let webLogDirs = [];
  let webLogOffsets = new Map();
  let webOriginalModel = null;
  let webTemporaryModel = null;
  const runnerStream = {
    write(chunk) {
      const text = String(chunk);
      if (args.mode === "web") {
        webRunner = appendBoundedDiagnostic(webRunner, text, WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
      }
      return stderr.write(text);
    },
  };
  const reportDiagnosticsFailure = (error) => {
    if (webDiagnosticsFailureReported) return;
    webDiagnosticsFailureReported = true;
    const detail = redactConnectedDiagnostics(
      limitDiagnosticText(
        error instanceof Error ? error.message : String(error),
        WEB_DIAGNOSTIC_SOURCE_MAX_BYTES,
      ),
    );
    try {
      stderr.write(`Web diagnostics unavailable (run result preserved): ${detail}\n`);
    } catch {
      // Diagnostics reporting is also best-effort.
    }
  };
  const flushWebDiagnostics = async () => {
    if (!webDiagnostics || webDiagnosticsFlushed) return false;
    if (webDiagnosticsFlushPromise) return webDiagnosticsFlushPromise;
    webDiagnosticsFlushPromise = (async () => {
      try {
        const log = await readLogs(webLogDirs, webLogOffsets);
        const content = formatWebDiagnostics({
          originalModel: webOriginalModel,
          temporaryModel: webTemporaryModel,
          runner: webRunner,
          server: webServer,
          log,
        });
        await writeDiagnostics(webDiagnostics.filePath, content);
        stderr.write(`${formatWebDiagnosticsPath(webDiagnostics.filePath)}\n`);
        webDiagnosticsFlushed = true;
        return true;
      } catch (error) {
        reportDiagnosticsFailure(error);
        return false;
      } finally {
        webDiagnosticsFlushPromise = null;
      }
    })();
    return webDiagnosticsFlushPromise;
  };
  const cleanup = async () => {
    if (cleaned || !workspace) return;
    cleaned = true;
    await cleanupConnectedWorkspace(workspace.tempRoot, {
      tmpdir: workspace.tmpdir ?? tmpdirBase,
    });
  };
  const onSignal = (signal) => {
    if (!interruptSignal) interruptSignal = signal;
    killChild(activeChild, signal, { graceMs: signalGraceMs });
  };
  const detachSignals = attachSignalForwarder(signalSource, onSignal);

  try {
    if (args.mode === "web") {
      try {
        webDiagnostics = await createDiagnostics({ tmpdir: tmpdirBase });
      } catch (error) {
        reportDiagnosticsFailure(error);
      }
    }
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
      await flushWebDiagnostics();
      await cleanup();
      return signalExitCode(interruptSignal);
    }
    if (build.code !== 0) {
      await flushWebDiagnostics();
      return build.code ?? 1;
    }
    if (!existsSync(path.resolve(io.repoRoot ?? repoRoot, "dist", "index.js"))) {
      runnerStream.write("Build did not produce dist/index.js.\n");
      await flushWebDiagnostics();
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
      await flushWebDiagnostics();
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
      stderr: runnerStream,
    });

    const childEnv = buildConnectedChildEnv(env, workspace.configDir);
    const launchArgs = assertNoModelRequest(connectedLaunchArgs(args.mode));
    if (args.mode === "web") {
      webLogDirs = resolveOpenCodeLogDirs(
        env,
        io.home ?? homedir(),
        io.platform ?? process.platform,
      );
      webLogOffsets = await snapshotLogOffsets(webLogDirs);
      if (interruptSignal) {
        await flushWebDiagnostics();
        await cleanup();
        return signalExitCode(interruptSignal);
      }
      const modelPrep = await prepareConnectedWebModel({
        opencodeBin,
        configDir: workspace.configDir,
        projectDir: workspace.projectDir,
        env,
        mainPath: workspace.mainPath,
        runCaptured: io.runCaptured,
        signalSource: null,
        signalGraceMs,
        onSpawn(child) {
          activeChild = child;
        },
      });
      activeChild = null;
      const preflightSignal = interruptSignal ?? modelPrep.signal;
      if (preflightSignal) {
        await flushWebDiagnostics();
        await cleanup();
        return signalExitCode(preflightSignal);
      }
      webOriginalModel = modelPrep.originalModel;
      webTemporaryModel = modelPrep.temporaryModel;
      runnerStream.write(`${formatWebModelChoice(modelPrep)}\n`);
      if (modelPrep.replaced) {
        await tightenCopiedPermissions(workspace.tempRoot);
      }
      if (!modelPrep.ok) {
        runnerStream.write(`${modelPrep.guidance}\n`);
        await flushWebDiagnostics();
        await cleanup();
        return 1;
      }
      if (interruptSignal) {
        await flushWebDiagnostics();
        await cleanup();
        return signalExitCode(interruptSignal);
      }
      const first = await runCapturedProcess(opencodeBin, launchArgs, {
        cwd: workspace.projectDir,
        env: childEnv,
        stdio: ["inherit", "pipe", "pipe"],
        forward: { stdout, stderr },
        signalGraceMs,
        signalSource: null,
        onSpawn(child) {
          activeChild = child;
        },
        onChunk(_stream, text) {
          webServer = appendBoundedDiagnostic(webServer, text, WEB_DIAGNOSTIC_SOURCE_MAX_BYTES);
        },
      });
      activeChild = null;
      await flushWebDiagnostics();
      await cleanup();
      if (interruptSignal) return signalExitCode(interruptSignal);
      return first.code ?? (first.signal ? signalExitCode(first.signal) : 0);
    }
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
        stderr.write(
          "Launching second TUI session with the prompt bar enabled. The bar is fixed at 12 cells; check provider identity and placement/clipping on resize, not bar growth.\n",
        );
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
    const message = `${error instanceof Error ? error.message : String(error)}\n`;
    runnerStream.write(message);
    await flushWebDiagnostics();
    await cleanup();
    return interruptSignal ? signalExitCode(interruptSignal) : 1;
  } finally {
    detachSignals();
    await flushWebDiagnostics();
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
