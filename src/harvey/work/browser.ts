import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, randomUUID } from "crypto";
import { mkdirSync, chownSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import { Connection, get, list, put, seal, unseal, workDir, text } from "./store.js";

const ALLOWED = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type", "browser_fill_form", "browser_press_key", "browser_select_option", "browser_hover", "browser_drag", "browser_tabs", "browser_wait_for", "browser_handle_dialog", "browser_file_upload", "browser_take_screenshot", "browser_close"]);
type Session = { client: Client; tools: any[]; lastUsed: number };
const sessions = new Map<string, Promise<Session>>();
export function browserEnabled() { return process.env.HARVEY_BROWSER_ENABLED === "true"; }
export function browserDirectory(owner: string, chat: string) { const key = createHash("sha256").update(owner + ":" + chat).digest("hex"); const dir = join(workDir(), "browsers", key); mkdirSync(dir, { recursive: true }); return dir; }
async function session(owner: string, chat: string): Promise<Session> {
  if (!browserEnabled()) throw new Error("Harvey's hosted browser is not enabled yet. Set HARVEY_BROWSER_ENABLED=true after installing Chromium.");
  const key = owner + ":" + chat;
  if (!sessions.has(key)) {
    if (sessions.size >= Number(process.env.HARVEY_BROWSER_MAX_SESSIONS || 3)) throw new Error("All browser slots are busy. Close another chat's browser or try again shortly.");
    const promise = (async () => {
      const dir = browserDirectory(owner, chat), files = join(dir, "files"); mkdirSync(files, { recursive: true });
      // Root containers launch the browser child as an unprivileged user.
      const unprivileged = process.platform !== "win32" && process.getuid?.() === 0;
      if (unprivileged) { chownSync(dir, 1001, 1001); chownSync(files, 1001, 1001); }
      const config = { browser: { browserName: "chromium", userDataDir: join(dir, "profile"), launchOptions: { headless: true, ...(process.env.HARVEY_BROWSER_EXECUTABLE ? { executablePath: process.env.HARVEY_BROWSER_EXECUTABLE } : {}) } }, outputDir: files, saveSession: false, imageResponses: "omit" };
      // A fixed worker entrypoint avoids shell commands and a separate LLM.
      const { writeFileSync } = await import("fs"); const configPath = join(dir, "config.json"); writeFileSync(configPath, JSON.stringify(config));
      const client = new Client({ name: "harvey-browser", version: "1.0.0" });
      const env: Record<string,string> = {};
      for (const name of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "SystemRoot", "TEMP", "TMP", "PLAYWRIGHT_BROWSERS_PATH"]) if (process.env[name]) env[name] = process.env[name]!;
      env.HOME = dir;
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(__dirname, "browserWorker.js"), "--config", configPath], cwd: files, env, stderr: "pipe" });
      let startupError = "";
      transport.stderr?.on("data", b => { startupError = (startupError + String(b)).slice(-2000); });
      try { await client.connect(transport, { timeout: 15000 }); const tools = (await client.listTools({}, { timeout: 15000 })).tools.filter(t => ALLOWED.has(t.name)); return { client, tools, lastUsed: Date.now() }; }
      catch (e) { await client.close().catch(() => {}); throw new Error(`Browser startup failed: ${(e as Error).message}${startupError ? ". " + startupError : ""}`); }
    })().catch(e => { sessions.delete(key); throw e; });
    sessions.set(key, promise);
  }
  const s = await sessions.get(key)!; s.lastUsed = Date.now(); return s;
}
export async function closeBrowser(owner: string, chat: string) { const key = owner + ":" + chat, promise = sessions.get(key); if (promise) { sessions.delete(key); const s = await promise.catch(() => null); await s?.client.close().catch(() => {}); } }
export async function closeBrowsers() { const keys = [...sessions.keys()]; for (const key of keys) { const s = await sessions.get(key)?.catch(() => null); await s?.client.close().catch(() => {}); sessions.delete(key); } }
const idle = setInterval(() => { for (const [key, value] of sessions) void value.then(async s => { if (Date.now() - s.lastUsed > 10 * 60_000) { sessions.delete(key); await s.client.close(); } }).catch(() => {}); }, 60000); idle.unref();
export async function browserTools(owner: string, chat: string) { return (await session(owner, chat)).tools; }
export async function browserCall(owner: string, chat: string, name: string, args: any) {
  if (!ALLOWED.has(name)) throw new Error("Unsupported browser action");
  if (name === "browser_navigate") { const url = new URL(text(args.url, "URL", 4000)); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) URL without embedded credentials"); }
  const filesDir = join(browserDirectory(owner, chat), "files");
  if (name === "browser_file_upload") { for (const file of args.paths || []) { if (!resolve(file).startsWith(resolve(filesDir) + sep)) throw new Error("Upload files must belong to this chat's browser workspace"); } }
  if (name === "browser_take_screenshot") args = { ...args, filename: undefined };
  const s = await session(owner, chat); const result = await s.client.callTool({ name, arguments: args || {} }, undefined, { timeout: 60000 }); s.lastUsed = Date.now();
  if (result.isError) throw new Error(JSON.stringify(result.content).slice(0, 2000));
  if (name === "browser_close") await closeBrowser(owner, chat); return result;
}
export function saveLogin(owner: string, input: any) {
  if (input.projectId) get("project", owner, input.projectId);
  const url = new URL(text(input.url, "Login URL", 2000)); if (url.protocol !== "https:" || url.username || url.password) throw new Error("Use an HTTPS login URL");
  if (typeof input.password !== "string" || !input.password.length || input.password.length > 2000) throw new Error("Password is required (maximum 2000 characters)");
  return put("login", owner, { id: randomUUID(), name: text(input.name, "Login name", 100), projectId: input.projectId || null, url: url.toString(), secret: seal({ username: text(input.username, "Username", 500), password: input.password }) });
}
export function logins(owner: string, projectId?: string | null) { return list<any>("login", owner).filter(c => projectId === undefined || !c.projectId || c.projectId === projectId).map(({ secret, ...c }) => c); }
export async function fillSavedLogin(owner: string, chat: string, projectId: string | null, input: any) {
  const login = get<any>("login", owner, text(input.loginId, "Login")); if (login.projectId && login.projectId !== projectId) throw new Error("Login belongs to another project");
  // Check the current page's URL from the browser itself, never the model's claim.
  const s = await session(owner, chat); const snap: any = await s.client.callTool({ name: "browser_snapshot", arguments: {} });
  const snapshot = (snap.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const pageUrl = snapshot.match(/- Page URL: (https?:\/\/[^\s]+)/)?.[1];
  if (!pageUrl || new URL(pageUrl).origin !== new URL(login.url).origin) throw new Error("Navigate to the saved login's exact origin before using it");
  const credentials = unseal(login.secret);
  // One fill call minimizes the gap between verifying the destination and typing.
  const targetKey = s.tools.find(t=>t.name === "browser_fill_form")?.inputSchema?.properties?.fields?.items?.properties?.target ? "target" : "ref";
  const filled = await s.client.callTool({ name: "browser_fill_form", arguments: { fields: [
    { name: "Username", type: "textbox", [targetKey]: text(input.usernameRef, "Username field reference", 100), value: credentials.username },
    { name: "Password", type: "textbox", [targetKey]: text(input.passwordRef, "Password field reference", 100), value: credentials.password },
  ] } });
  if (filled.isError) throw new Error("The saved login could not be filled. Inspect fresh field references and try again.");
  return { filled: true, note: "Saved login filled. Inspect the page, then submit if requested. MFA or CAPTCHA may need the user's help." };
}
