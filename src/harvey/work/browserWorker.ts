/** Launched only by browser.ts. No application secrets are inherited. */
import { dirname, join } from "path";
if (process.platform !== "win32" && process.getuid?.() === 0) {
  process.setgroups!([]); process.setgid!(1001); process.setuid!(1001);
}
require(join(dirname(require.resolve("@playwright/mcp/package.json")), "cli.js"));
