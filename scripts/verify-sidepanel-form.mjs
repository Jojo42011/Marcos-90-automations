/* Drives sidepanel.html in a real browser with chrome.* stubbed, and checks
   the one thing the operator hit: a token being typed must survive the
   periodic status repaint instead of being wiped after ~3 seconds. */
import { chromium } from "playwright";
import http from "http";
import { readFileSync } from "fs";
import path from "path";

const dir = "public/extension";
const srv = http.createServer((req, res) => {
  const f = path.join(dir, req.url === "/" ? "sidepanel.html" : req.url.split("?")[0]);
  try { res.end(readFileSync(f)); } catch { res.statusCode = 404; res.end("nope"); }
}).listen(3470);

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const p = await b.newPage();
// chrome.* stub: in-memory storage so the page runs outside an extension.
await p.addInitScript(() => {
  const store = {};
  window.chrome = {
    storage: { local: {
      get: (keys) => Promise.resolve(Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,store[k]]).filter(([,v])=>v!==undefined))),
      set: (obj) => { Object.assign(store, obj); return Promise.resolve(); },
      remove: (k) => { delete store[k]; return Promise.resolve(); },
    }},
    runtime: { sendMessage: (_m, cb) => cb && cb({ ok: true }) },
  };
});
let pass = 0; const fail = [];
const ok = (n,c)=> c?pass++:fail.push(n);

await p.goto("http://localhost:3470/", { waitUntil: "networkidle" });
await p.click("#toggleSetup");

// 1. Type a token slowly, then trigger the status repaint that used to wipe it.
await p.click("#token");
await p.type("#token", "my-secret-token", { delay: 40 });
await p.evaluate(() => refresh());        // the 15s-timer path, forced now
await p.waitForTimeout(300);
ok("token survives repaint while focused", (await p.inputValue("#token")) === "my-secret-token");

// 2. Blur the field (click elsewhere), repaint again — unsaved edits must still survive.
await p.click("#deviceName");
await p.evaluate(() => refresh());
await p.waitForTimeout(300);
ok("token survives repaint after blur (unsaved edit)", (await p.inputValue("#token")) === "my-secret-token");

// 3. Half-filled save is refused with a named reason, not stored.
await p.click("#save");
ok("save without server names the missing field", /server address/i.test(await p.textContent("#statusText")));

// 4. Full save persists, normalizes, and repaints keep showing the saved value.
await p.fill("#serverUrl", "https://marco-90-automation.fly.dev/shell");
await p.fill("#deviceName", "Test rig");
await p.click("#save");
await p.waitForTimeout(300);
ok("server URL normalized to origin on save", (await p.inputValue("#serverUrl")) === "https://marco-90-automation.fly.dev");
await p.evaluate(() => refresh());
await p.waitForTimeout(300);
ok("saved token still shown after repaint", (await p.inputValue("#token")) === "my-secret-token");

// 5. And a NEW edit on top of a saved value also survives a repaint.
await p.fill("#token", "replacement-token");
await p.evaluate(() => refresh());
await p.waitForTimeout(300);
ok("edited-but-unsaved replacement survives repaint", (await p.inputValue("#token")) === "replacement-token");

console.log(`\n${pass} passed, ${fail.length} failed`);
for (const f of fail) console.log("  ✗ " + f);
await b.close(); srv.close();
process.exit(fail.length ? 1 : 0);
