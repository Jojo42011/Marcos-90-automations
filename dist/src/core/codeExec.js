"use strict";
/**
 * Phase A of Harvey's code execution: run a generated script locally, hardened.
 *
 * WHY THIS EXISTS. Harvey's tools are a fixed vocabulary, so anything outside it
 * is impossible however trivial — "which contacts share a phone number", "sum
 * the GCI column and check my math". That last one is the real argument: a model
 * doing arithmetic on 200 rows in its head will sometimes be wrong and will
 * always sound certain. Executing a script turns "Harvey says $412k" into
 * "Harvey computed $412k, and here is the script that did it".
 *
 * WHAT THIS IS NOT. `local` mode is HARDENING, NOT ISOLATION, and the difference
 * matters enough to spell out:
 *
 *   - The environment is built from an ALLOW-LIST (PATH, HOME, LANG, TMPDIR and
 *     nothing else), so no script ever sees ANTHROPIC_API_KEY, BRIVITY_API_KEY,
 *     TWILIO_AUTH_TOKEN or the Fly deploy token. Even with network access a
 *     script cannot authenticate as Marco anywhere.
 *   - Node runs under `--permission` with filesystem reads and writes scoped to
 *     the run directory, and WITHOUT `--allow-child-process`, so it cannot shell
 *     out to reach what it is not allowed to touch directly.
 *   - Network is stubbed at the language level: a preload throws on
 *     net/http/https/tls/dns and removes global fetch (Node), and a
 *     `sitecustomize.py` raises on socket creation, which is underneath urllib,
 *     requests and http.client (Python).
 *   - Wall-clock timeout, output cap, code-size cap, one process at a time.
 *
 * None of that is a security boundary. A sufficiently determined script may
 * still find a way out of a process running as root in the app's own container.
 * That is precisely why `sandbox` mode (Phase B — a disposable Fly Machine with
 * no secrets, no volume and no egress) exists, and why the default is `off`.
 *
 * DEFAULT OFF. `HARVEY_EXEC_MODE` must be set to `local` deliberately. A
 * capability this sharp does not arrive because something happened to deploy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.execMode = execMode;
exports.runScript = runScript;
exports.execStatus = execStatus;
const node_child_process_1 = require("node:child_process");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
const workspace_js_1 = require("./workspace.js");
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CODE_CHARS = 100_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_INPUTS = 10;
/** Room for a chart or a joined CSV, not for a video. */
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
function execMode() {
    const raw = (process.env.HARVEY_EXEC_MODE || "").trim().toLowerCase();
    if (raw === "local" || raw === "sandbox")
        return raw;
    return "off";
}
/* ─────────────── the language shims ─────────────── */
/**
 * Node preload. Network modules throw on require and the global fetch is
 * removed, so a script has to be explicit about wanting something it cannot
 * have — and gets a clear message rather than a silent hang.
 */
const NODE_GUARD = `
const Module = require("node:module");
const BLOCKED = new Set(["net","http","https","http2","tls","dgram","dns","dns/promises",
  "node:net","node:http","node:https","node:http2","node:tls","node:dgram","node:dns","node:dns/promises",
  "child_process","node:child_process","worker_threads","node:worker_threads","inspector","node:inspector"]);
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (BLOCKED.has(request)) {
    throw new Error("'" + request + "' is not available: scripts run with no network and no subprocesses.");
  }
  return realLoad.call(this, request, parent, isMain);
};
for (const g of ["fetch","WebSocket","XMLHttpRequest","EventSource"]) {
  try { Object.defineProperty(globalThis, g, { value: undefined, configurable: false, writable: false }); } catch (_) {}
}
`;
/**
 * Python shim. Blocking socket creation is enough to stop urllib, requests and
 * http.client, which all sit on top of it — there is no permission model to lean
 * on here, so this plus a credential-free environment is the whole defence.
 */
const PY_GUARD = `
import socket, sys
class _NoNet(socket.socket):
    def __init__(self, *a, **k):
        raise OSError("network is unavailable: scripts run with no network access")
socket.socket = _NoNet
def _blocked(*a, **k):
    raise OSError("network is unavailable: scripts run with no network access")
socket.create_connection = _blocked
socket.getaddrinfo = _blocked
`;
/**
 * Environment built by allow-list, never by deleting known-bad keys — a
 * deny-list silently leaks whatever secret gets added next.
 */
function scrubbedEnv(runDir) {
    return {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: runDir,
        TMPDIR: runDir,
        LANG: process.env.LANG || "C.UTF-8",
        LC_ALL: process.env.LC_ALL || "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        NODE_ENV: "sandbox",
        HARVEY_EXEC: "1",
    };
}
function cap(s) {
    if (s.length <= MAX_OUTPUT_CHARS)
        return { text: s, truncated: false };
    return {
        text: s.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated: ${s.length - MAX_OUTPUT_CHARS} more characters]`,
        truncated: true,
    };
}
async function listRunArtifacts(runDir, relDir) {
    const out = [];
    const walk = async (dir) => {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const e of entries) {
            const full = (0, node_path_1.join)(dir, e.name);
            if (e.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!e.isFile())
                continue;
            const st = await (0, promises_1.stat)(full).catch(() => null);
            if (!st)
                continue;
            if (st.size > MAX_ARTIFACT_BYTES)
                continue;
            out.push({ path: (0, node_path_1.join)(relDir, (0, node_path_1.relative)(runDir, full)).split("\\").join("/"), bytes: st.size });
        }
    };
    await walk(runDir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
}
/**
 * Run a script and report exactly what happened.
 *
 * A timeout is reported AS a timeout and a non-zero exit AS a failure. Neither
 * is ever summarised as "no results" — a script killed at 20s that gets
 * described as an empty result set is the worst possible outcome, because it
 * looks like an answer.
 */
async function runScript(opts) {
    const mode = execMode();
    const language = opts.language === "python" ? "python" : "node";
    const base = {
        ok: false, mode, language, exitCode: null, timedOut: false, durationMs: 0,
        stdout: "", stderr: "", truncated: false, files: [], runDir: "",
    };
    if (mode === "off") {
        return { ...base, error: "Code execution is disabled on this server (HARVEY_EXEC_MODE is off).",
            note: "This is the default. It has to be switched on deliberately." };
    }
    if (mode === "sandbox") {
        return { ...base, error: "Sandbox execution is not built yet (Phase B).",
            note: "HARVEY_EXEC_MODE is set to 'sandbox' but no sandbox is wired up. Nothing was run — set it to 'local' to use the hardened local runner, or leave it off." };
    }
    const code = String(opts.code ?? "");
    if (!code.trim())
        return { ...base, error: "code is required." };
    if (code.length > MAX_CODE_CHARS) {
        return { ...base, error: `Script is too long (${code.length} chars, limit ${MAX_CODE_CHARS}).` };
    }
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const runId = `${Date.now().toString(36)}_${(0, node_crypto_1.randomUUID)().slice(0, 6)}`;
    const relDir = `runs/${runId}`;
    const runDir = (0, node_path_1.join)(workspace_js_1.WORKSPACE_ROOT, "runs", runId);
    await (0, promises_1.mkdir)(runDir, { recursive: true });
    base.runDir = relDir;
    /* Inputs are COPIED IN rather than the script being pointed at the workspace.
       It is more work per task and it is the property that makes this safe: a
       script sees the data it was given and nothing else. */
    const inputs = Array.isArray(opts.inputs) ? opts.inputs.slice(0, MAX_INPUTS) : [];
    const copied = [];
    for (const rel of inputs) {
        try {
            const src = (0, workspace_js_1.safePath)(rel);
            const st = await (0, promises_1.stat)(src);
            if (!st.isFile() || st.size > MAX_ARTIFACT_BYTES)
                continue;
            const name = String(rel).split("/").pop() || "input";
            await (0, promises_1.writeFile)((0, node_path_1.join)(runDir, name), await (0, promises_1.readFile)(src));
            copied.push(name);
        }
        catch {
            return { ...base, error: `Could not read input file: ${rel}` };
        }
    }
    const scriptName = language === "python" ? "script.py" : "script.js";
    await (0, promises_1.writeFile)((0, node_path_1.join)(runDir, scriptName), code, "utf8");
    let bin;
    let args;
    if (language === "python") {
        await (0, promises_1.writeFile)((0, node_path_1.join)(runDir, "sitecustomize.py"), PY_GUARD, "utf8");
        bin = "python3";
        args = ["-I", "-S", "-c",
            `import sys;sys.path.insert(0,'.');import sitecustomize;exec(open('${scriptName}').read(),{'__name__':'__main__','__file__':'${scriptName}'})`];
    }
    else {
        await (0, promises_1.writeFile)((0, node_path_1.join)(runDir, "guard.cjs"), NODE_GUARD, "utf8");
        bin = process.execPath;
        args = [
            "--permission",
            `--allow-fs-read=${runDir}`, `--allow-fs-read=${runDir}/*`,
            `--allow-fs-write=${runDir}`, `--allow-fs-write=${runDir}/*`,
            "--require", (0, node_path_1.join)(runDir, "guard.cjs"),
            scriptName,
        ];
    }
    const started = Date.now();
    const res = await new Promise((resolve) => {
        let out = "", err = "", timedOut = false, settled = false;
        const child = (0, node_child_process_1.spawn)(bin, args, {
            cwd: runDir,
            env: scrubbedEnv(runDir),
            shell: false, // no shell: nothing to inject into
            stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, timeoutMs);
        const finish = (c) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code: c, out, err, timedOut });
        };
        child.stdout?.on("data", (d) => { if (out.length < MAX_OUTPUT_CHARS * 2)
            out += String(d); });
        child.stderr?.on("data", (d) => { if (err.length < MAX_OUTPUT_CHARS * 2)
            err += String(d); });
        child.on("error", (e) => { err += `\nfailed to start: ${e.message}`; finish(null); });
        child.on("close", (c) => finish(c));
    });
    const durationMs = Date.now() - started;
    const so = cap(res.out);
    const se = cap(res.err);
    /* stdout is written to disk too, so an execution is auditable long after the
       job record has been read — the script and its output sit side by side. */
    await (0, promises_1.writeFile)((0, node_path_1.join)(runDir, "output.txt"), `# exit: ${res.timedOut ? "TIMED OUT" : res.code}\n# duration: ${durationMs}ms\n\n--- stdout ---\n${res.out}\n--- stderr ---\n${res.err}\n`, "utf8").catch(() => { });
    const files = await listRunArtifacts(runDir, relDir);
    const produced = files.filter((f) => !/\/(script\.(js|py)|guard\.cjs|sitecustomize\.py|output\.txt)$/.test(f.path)
        && !copied.some((c) => f.path.endsWith("/" + c)));
    return {
        ok: !res.timedOut && res.code === 0,
        mode, language,
        exitCode: res.timedOut ? null : res.code,
        timedOut: res.timedOut,
        durationMs,
        stdout: so.text,
        stderr: se.text,
        truncated: so.truncated || se.truncated,
        files,
        runDir: relDir,
        error: res.timedOut
            ? `Killed after ${timeoutMs}ms — the script did not finish. This is a timeout, NOT an empty result.`
            : res.code === 0 ? undefined : `Script exited with code ${res.code}.`,
        note: produced.length
            ? `Produced ${produced.length} file(s): ${produced.map((f) => f.path).join(", ")}`
            : undefined,
    };
}
/** What the operator (and Harvey) should be told about this capability. */
function execStatus() {
    const mode = execMode();
    return {
        mode,
        enabled: mode === "local",
        languages: ["node", "python"],
        timeoutMs: DEFAULT_TIMEOUT_MS,
        protections: [
            "environment built by allow-list — no API keys, tokens or credentials are present",
            "working directory is a fresh run folder under the workspace; inputs are copied in",
            "network stubbed at the language level (node: net/http/https/tls/dns throw, fetch removed; python: socket raises)",
            "node runs under --permission with fs scoped to the run folder and no child processes",
            "no shell, hard wall-clock timeout, output and file-size caps",
            "script, stdout and exit code written to disk for audit",
        ],
        limits: [
            "local mode is hardening, not isolation — the process still runs in this container",
            "a script cannot authenticate anywhere, but a determined one is not provably contained",
            "sandbox mode (a disposable machine with no secrets and no egress) is Phase B and not built",
        ],
        note: mode === "off"
            ? "Disabled. Set HARVEY_EXEC_MODE=local to enable the hardened local runner."
            : mode === "sandbox"
                ? "Set to 'sandbox', which is not built yet — every run will refuse. Use 'local' or 'off'."
                : "Enabled in local mode: hardened, but not a sandbox. Do not treat it as one.",
    };
}
