"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/** Launched only by browser.ts. No application secrets are inherited. */
const path_1 = require("path");
if (process.platform !== "win32" && process.getuid?.() === 0) {
    process.setgroups([]);
    process.setgid(1001);
    process.setuid(1001);
}
require((0, path_1.join)((0, path_1.dirname)(require.resolve("@playwright/mcp/package.json")), "cli.js"));
