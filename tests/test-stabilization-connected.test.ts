import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyQuotaSurfaceSettings,
  buildConnectedChildEnv,
  CONNECTED_CREDENTIAL_WARNING,
  CONNECTED_TEMP_PREFIX,
  cleanupConnectedWorkspace,
  connectedLaunchArgs,
  findOpenCodeExecutable,
  getConnectedUsage,
  parseConnectedArgs,
  pluginFileUrls,
  prepareConnectedWorkspace,
  rewritePluginList,
  runConnected,
  runProcess,
} from "../scripts/test-stabilization-connected.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/test-stabilization-connected.mjs", import.meta.url),
);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SECRET = "connected-config-secret-canary";

let tempDir: string | undefined;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDir = dir;
  return dir;
}

afterEach(async () => {
  if (!tempDir) return;
  await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

async function writeConfigTree(root: string) {
  const realMain = path.join(root, "real-opencode.jsonc");
  await writeFile(
    realMain,
    `{
  // companion plugins stay first
  "$schema": "https://opencode.ai/config.json",
  "model": "test-model",
  "plugin": [
    "opencode-antigravity-auth",
    ["@slkiser/opencode-quota", { "enabled": true }],
    "opencode-agy-auth"
  ]
}
`,
    "utf8",
  );
  await symlink(realMain, path.join(root, "opencode.jsonc"));
  await writeFile(
    path.join(root, "tui.jsonc"),
    `{
  "plugin": ["@slkiser/opencode-quota"]
}
`,
    "utf8",
  );
  await mkdir(path.join(root, "opencode-quota"), { recursive: true });
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.jsonc"),
    `{
  "enabledProviders": "auto",
  "tuiSidebarPanel": {
    "opencodeGoPreferredWindow": "rolling"
  },
  "enableToast": false,
  "tuiCompactStatus": { "enabled": false },
  "tuiPromptBar": { "enabled": true }
}
`,
    "utf8",
  );
  await writeFile(path.join(root, "auth.json"), `${JSON.stringify({ token: SECRET })}\n`, "utf8");
}

async function writeJsonOnlyConfigTree(root: string) {
  await writeFile(
    path.join(root, "opencode.json"),
    `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "json-only-model",
      plugin: ["@slkiser/opencode-quota"],
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "tui.json"),
    `${JSON.stringify({ plugin: ["@slkiser/opencode-quota"] })}\n`,
    "utf8",
  );
  await mkdir(path.join(root, "opencode-quota"), { recursive: true });
  await writeFile(
    path.join(root, "opencode-quota", "quota-toast.json"),
    `${JSON.stringify({ enableToast: false })}\n`,
    "utf8",
  );
}

function runScript(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

async function prefixDirs(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith(CONNECTED_TEMP_PREFIX));
}

describe("test-stabilization-connected", () => {
  it("parses TUI, web, prompt-bar, dry-run, and help flags", () => {
    expect(parseConnectedArgs(["--help"])).toEqual({
      mode: null,
      promptBar: false,
      dryRun: false,
      help: true,
    });
    expect(parseConnectedArgs(["--tui", "--prompt-bar", "--dry-run"])).toEqual({
      mode: "tui",
      promptBar: true,
      dryRun: true,
      help: false,
    });
    expect(parseConnectedArgs(["--web"])).toMatchObject({ mode: "web", promptBar: false });
    expect(connectedLaunchArgs("web")).toEqual(["web"]);
    expect(connectedLaunchArgs("tui")).toEqual([]);
    expect(() => parseConnectedArgs([])).toThrow(/Specify --tui or --web/);
    expect(() => parseConnectedArgs(["--tui", "--web"])).toThrow(/only one/);
    expect(() => parseConnectedArgs(["--web", "--prompt-bar"])).toThrow(/only valid with --tui/);
    expect(getConnectedUsage()).toContain("--tui");
    expect(getConnectedUsage()).toMatch(/fixed 12-cell bar/i);
    expect(getConnectedUsage()).toMatch(/placement\/clipping/i);
  });

  it("rewrites only quota plugin entries and preserves companion order", () => {
    const url = "file:///tmp/dist/index.js";
    expect(
      rewritePluginList(
        ["opencode-antigravity-auth", "@slkiser/opencode-quota", "opencode-agy-auth"],
        url,
      ),
    ).toEqual(["opencode-antigravity-auth", url, "opencode-agy-auth"]);
    expect(rewritePluginList([["@slkiser/opencode-quota", { enabled: true }]], url)).toEqual([
      [url, { enabled: true }],
    ]);
    expect(rewritePluginList(["opencode-agy-auth"], url)).toEqual(["opencode-agy-auth", url]);
  });

  it("enables sidebar, toast, and compact without dropping unrelated quota settings", () => {
    const config = applyQuotaSurfaceSettings(
      {
        enabledProviders: "auto",
        tuiSidebarPanel: { opencodeGoPreferredWindow: "rolling" },
        enableToast: false,
      },
      { promptBarEnabled: false },
    );
    expect(config).toMatchObject({
      enabledProviders: "auto",
      enableToast: true,
      tuiSidebarPanel: { enabled: true, opencodeGoPreferredWindow: "rolling" },
      tuiCompactStatus: { enabled: true },
      tuiPromptBar: { enabled: false },
    });
  });

  it("strips OPENCODE_CONFIG from the child environment", () => {
    expect(
      buildConnectedChildEnv(
        {
          OPENCODE_CONFIG: "/real/opencode.json",
          OPENCODE_CONFIG_DIR: "/real/config",
          PATH: "/bin",
        },
        "/tmp/isolated-config",
      ),
    ).toEqual({
      OPENCODE_CONFIG_DIR: "/tmp/isolated-config",
      PATH: "/bin",
    });
  });

  it("copies through a symlink, rewrites the temp files, and leaves the real config unchanged", async () => {
    const root = await makeTemp("oq-connected-src-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeConfigTree(source);
    const originalMain = await readFile(path.join(source, "real-opencode.jsonc"), "utf8");
    const originalAuth = await readFile(path.join(source, "auth.json"), "utf8");

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    const copiedMainStat = await lstat(workspace.mainPath);
    expect(copiedMainStat.isSymbolicLink()).toBe(false);
    expect(await realpath(workspace.mainPath)).not.toBe(
      await realpath(path.join(source, "real-opencode.jsonc")),
    );

    const copiedMain = await readFile(workspace.mainPath, "utf8");
    const urls = pluginFileUrls(repoRoot);
    expect(copiedMain).toContain("// companion plugins stay first");
    expect(copiedMain).toContain("opencode-antigravity-auth");
    expect(copiedMain).toContain("opencode-agy-auth");
    expect(copiedMain).toContain(urls.server);
    expect(copiedMain).not.toContain("@slkiser/opencode-quota");
    expect(copiedMain).toContain('"model": "test-model"');

    const copiedTui = await readFile(workspace.tuiPath, "utf8");
    expect(copiedTui).toContain(urls.tui);

    const copiedQuota = JSON.parse(await readFile(workspace.quotaPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(copiedQuota).toMatchObject({
      enabledProviders: "auto",
      enableToast: true,
      tuiSidebarPanel: { enabled: true, opencodeGoPreferredWindow: "rolling" },
      tuiCompactStatus: { enabled: true },
      tuiPromptBar: { enabled: false },
    });

    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
    expect(await readFile(path.join(source, "auth.json"), "utf8")).toBe(originalAuth);
    expect(await readFile(path.join(workspace.configDir, "auth.json"), "utf8")).toContain(SECRET);

    if (process.platform !== "win32") {
      expect((await lstat(workspace.tempRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(workspace.configDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(workspace.projectDir)).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(workspace.configDir, "auth.json"))).mode & 0o777).toBe(0o600);
      expect((await lstat(workspace.mainPath)).mode & 0o777).toBe(0o600);
    }

    const tempRoot = workspace.tempRoot;
    await cleanupConnectedWorkspace(tempRoot, { tmpdir: root });
    await expect(lstat(tempRoot)).rejects.toThrow();
    expect(await readFile(path.join(source, "real-opencode.jsonc"), "utf8")).toBe(originalMain);
  });

  it("follows a symlinked config root with stat and still requires a directory", async () => {
    const root = await makeTemp("oq-connected-link-");
    const realSource = path.join(root, "real-source");
    const linkedSource = path.join(root, "linked-source");
    await mkdir(realSource);
    await writeConfigTree(realSource);
    await symlink(realSource, linkedSource);

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: linkedSource,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    expect(path.basename(workspace.mainPath)).toBe("opencode.jsonc");
    expect((await lstat(workspace.mainPath)).isSymbolicLink()).toBe(false);
    expect(await readFile(workspace.mainPath, "utf8")).toContain("test-model");
    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: path.join(root, "missing-link"),
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/config directory is missing/);
    const fileSource = path.join(root, "file-source");
    await writeFile(fileSource, "{}\n", "utf8");
    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: fileSource,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/config directory is missing/);
  });

  it("rewrites JSON-only configs without requiring jsonc files", async () => {
    const root = await makeTemp("oq-connected-json-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeJsonOnlyConfigTree(source);

    const workspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      promptBarEnabled: false,
      tmpdir: root,
    });
    tempDir = root;

    expect(workspace.mainPath).toBe(path.join(workspace.configDir, "opencode.json"));
    expect(workspace.tuiPath).toBe(path.join(workspace.configDir, "tui.json"));
    expect(workspace.quotaPath).toBe(
      path.join(workspace.configDir, "opencode-quota", "quota-toast.json"),
    );
    const urls = pluginFileUrls(repoRoot);
    expect(await readFile(workspace.mainPath, "utf8")).toContain(urls.server);
    expect(await readFile(workspace.tuiPath, "utf8")).toContain(urls.tui);
  });

  it("rejects a config directory that is missing the main OpenCode config", async () => {
    const root = await makeTemp("oq-connected-missing-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "auth.json"),
      `${JSON.stringify({ token: SECRET })}\n`,
      "utf8",
    );

    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: source,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/missing opencode\.json or opencode\.jsonc/);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("creates a TUI config for TUI runs and leaves it absent for web when missing", async () => {
    const root = await makeTemp("oq-connected-tui-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(
      path.join(source, "opencode.jsonc"),
      `${JSON.stringify({ plugin: ["@slkiser/opencode-quota"] })}\n`,
      "utf8",
    );

    const tuiWorkspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      ensureTuiConfig: true,
      tmpdir: root,
    });
    expect(tuiWorkspace.tuiPath).toBe(path.join(tuiWorkspace.configDir, "tui.jsonc"));
    expect(await readFile(tuiWorkspace.tuiPath, "utf8")).toContain(pluginFileUrls(repoRoot).tui);
    await cleanupConnectedWorkspace(tuiWorkspace.tempRoot, { tmpdir: root });

    const webWorkspace = await prepareConnectedWorkspace({
      sourceConfigDir: source,
      repoRoot,
      ensureTuiConfig: false,
      tmpdir: root,
    });
    tempDir = root;
    expect(webWorkspace.tuiPath).toBeNull();
    await expect(lstat(path.join(webWorkspace.configDir, "tui.jsonc"))).rejects.toThrow();
    await expect(lstat(path.join(webWorkspace.configDir, "tui.json"))).rejects.toThrow();
  });

  it("deletes the temp workspace if copy or transform fails", async () => {
    const root = await makeTemp("oq-connected-fail-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "opencode.jsonc"), "not-json {\n", "utf8");

    await expect(
      prepareConnectedWorkspace({
        sourceConfigDir: source,
        repoRoot,
        tmpdir: root,
      }),
    ).rejects.toThrow(/Failed to parse copied opencode\.jsonc/);
    expect(await prefixDirs(root)).toEqual([]);
  });

  it("refuses to delete a path outside the expected temp prefix", async () => {
    const root = await makeTemp("oq-connected-guard-");
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(source, "keep.txt"), "keep\n", "utf8");
    const tmp = path.join(root, "tmp");
    await mkdir(tmp);

    await expect(cleanupConnectedWorkspace(source, { tmpdir: tmp })).rejects.toThrow(
      /Refusing to delete/,
    );
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("keep\n");

    const decoy = path.join(tmp, `${CONNECTED_TEMP_PREFIX}decoy`);
    await symlink(source, decoy);
    await expect(cleanupConnectedWorkspace(decoy, { tmpdir: tmp })).rejects.toThrow(
      /Refusing to delete/,
    );
    expect(await readFile(path.join(source, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("forwards SIGTERM to the child, waits for exit, then cleanup can run", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-sig-");
    const childScript = path.join(root, "child.mjs");
    const marker = path.join(root, "marker.txt");
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "started\\n");
process.on("SIGTERM", () => {
  writeFileSync(process.argv[2], "exited\\n");
  process.exit(0);
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const signalSource = new EventEmitter();
    const events: string[] = [];
    const running = runProcess(process.execPath, [childScript, marker], {
      cwd: root,
      stdio: "ignore",
      signalSource,
    }).then((result: { code: number | null; signal: NodeJS.Signals | null }) => {
      events.push("child-exit");
      return result;
    });

    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(marker, "utf8")) === "started\n") break;
      } catch {
        // The child has not created the marker yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(marker, "utf8")).toBe("started\n");
    signalSource.emit("SIGTERM");
    const result = await running;
    events.push("cleanup");
    expect(await readFile(marker, "utf8")).toBe("exited\n");
    expect(result.code).toBe(0);
    expect(events).toEqual(["child-exit", "cleanup"]);
  });

  it("escalates an ignored SIGTERM to SIGKILL after the grace period, then cleanup can run", async () => {
    if (process.platform === "win32") return;
    const root = await makeTemp("oq-connected-kill-");
    const childScript = path.join(root, "ignore.mjs");
    const marker = path.join(root, "marker.txt");
    const pidsFile = path.join(root, "pids.json");
    const grandchildSource =
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); process.on('SIGHUP', () => {}); setInterval(() => {}, 1000);";
    await writeFile(
      childScript,
      `import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {
  writeFileSync(process.argv[2], "ignored\\n");
});
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}], {
  detached: false,
  stdio: "ignore",
});
writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
writeFileSync(process.argv[2], "started\\n");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const signalSource = new EventEmitter();
    const events: string[] = [];
    const graceMs = 80;
    const running = runProcess(process.execPath, [childScript, marker, pidsFile], {
      cwd: root,
      stdio: "ignore",
      signalSource,
      signalGraceMs: graceMs,
    }).then((result: { code: number | null; signal: NodeJS.Signals | null }) => {
      events.push("child-exit");
      return result;
    });

    for (let i = 0; i < 100; i++) {
      try {
        if ((await readFile(marker, "utf8")) === "started\n") break;
      } catch {
        // The child has not created the marker yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await readFile(marker, "utf8")).toBe("started\n");
    const pids = JSON.parse(await readFile(pidsFile, "utf8")) as {
      parent: number;
      grandchild: number;
    };
    const signaledAt = Date.now();
    signalSource.emit("SIGTERM");
    const result = await running;
    const elapsed = Date.now() - signaledAt;
    events.push("cleanup");
    expect(await readFile(marker, "utf8")).toBe("ignored\n");
    expect(result.signal).toBe("SIGKILL");
    expect(result.code).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(graceMs);
    expect(elapsed).toBeLessThan(graceMs + 2000);
    expect(events).toEqual(["child-exit", "cleanup"]);
    expect(() => process.kill(pids.parent, 0)).toThrow();
    expect(() => process.kill(pids.grandchild, 0)).toThrow();
  });

  it("prints help without requiring config or OpenCode", async () => {
    const logs: string[] = [];
    const code = await runConnected(["--help"], {
      stdout: {
        write(chunk: string) {
          logs.push(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
      env: { PATH: "" },
    });
    expect(code).toBe(0);
    expect(logs.join("")).toContain("--tui");
    expect(logs.join("")).not.toContain(SECRET);
  });

  it("fails dry-run clearly when config or OpenCode is missing", () => {
    const missingConfig = runScript(["--dry-run", "--tui"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: path.join(tmpdir(), "missing-opencode-config-dir"),
      PATH: "",
    });
    expect(missingConfig.status).toBe(1);
    expect(`${missingConfig.stdout}${missingConfig.stderr}`).toMatch(
      /config directory is missing/i,
    );
    expect(`${missingConfig.stdout}${missingConfig.stderr}`).not.toContain(SECRET);
  });

  it("dry-run warns about real credentials and does not print copied secrets", async () => {
    const root = await makeTemp("oq-connected-dry-");
    const source = path.join(root, "source");
    const bin = path.join(root, "bin");
    await mkdir(source);
    await mkdir(bin);
    await writeConfigTree(source);
    const opencodePath = path.join(bin, process.platform === "win32" ? "opencode.cmd" : "opencode");
    await writeFile(opencodePath, process.platform === "win32" ? "@echo off\n" : "#!/bin/sh\n");
    if (process.platform !== "win32") await chmod(opencodePath, 0o755);

    expect(findOpenCodeExecutable({ PATH: bin })).toBe(opencodePath);

    const result = runScript(["--dry-run", "--tui"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: source,
      PATH: bin,
    });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).toBe(0);
    expect(output).toContain(CONNECTED_CREDENTIAL_WARNING);
    expect(output).toContain("Dry run");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("test-model");
    expect(output).not.toContain("companion plugins stay first");

    const web = runScript(["--dry-run", "--web"], {
      ...process.env,
      OPENCODE_CONFIG_DIR: source,
      PATH: bin,
    });
    const webOutput = `${web.stdout}${web.stderr}`;
    expect(web.status).toBe(0);
    expect(webOutput).toContain("Mode: web");
    expect(webOutput).not.toContain(SECRET);
  });
});
