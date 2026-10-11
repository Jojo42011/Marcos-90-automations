import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataPath, tenantOwner } from "./tenantData.js";

export function publicResource(path: string): boolean {
  return /^\/r\/(open|click|stop|report)$/.test(path) || /^\/c\/[^/]+$/.test(path);
}
function keyPath(owner: string): string {
  if (tenantOwner()) {
    if (owner !== tenantOwner()) throw new Error("Public link account mismatch");
    return dataPath("public-link.key");
  }
  return owner ? join(dataPath(), "accounts", createHash("sha256").update(owner).digest("hex"), "public-link.key") : dataPath("public-link.key");
}
function canonical(url: URL): string {
  const copy = new URL(url); copy.searchParams.delete("signature"); copy.searchParams.sort();
  return copy.pathname + copy.search;
}
/** A capability covers exactly one route and its parameters, with no account session. */
export function publicLink(path: string): string {
  const url = new URL(path, "http://public.local");
  if (!publicResource(url.pathname)) throw new Error("Unsupported public resource");
  const owner = tenantOwner();
  if (process.env.ACCOUNT_ISOLATION !== "true") return path;
  const file = keyPath(owner);
  mkdirSync(dirname(file), {recursive:true});
  if (!existsSync(file)) { try { writeFileSync(file, randomBytes(32).toString("hex"), {flag:"wx",mode:0o600}); } catch(error) { if((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  url.searchParams.set("owner", owner);
  url.searchParams.set("signature", createHmac("sha256", readFileSync(file)).update(canonical(url)).digest("hex"));
  return url.pathname + url.search;
}
export function verifyPublicLink(path: string): string | undefined {
  try {
    const url = new URL(path,"http://public.local");
    if (!publicResource(url.pathname)) return;
    const owner = url.searchParams.get("owner");
    const signature = url.searchParams.get("signature") || "";
    if (owner === null || !/^[a-f0-9]{64}$/.test(signature)) return;
    const expected = createHmac("sha256",readFileSync(keyPath(owner))).update(canonical(url)).digest();
    if (timingSafeEqual(expected,Buffer.from(signature,"hex"))) return owner;
  } catch { /* Invalid capabilities never fall back to authenticated account routing. */ }
}
