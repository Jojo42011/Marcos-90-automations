import { existsSync } from "node:fs";
import { join } from "node:path";

/** Each account runs in its own process: legacy stores also cache data in memory. */
export function dataPath(...parts: string[]): string {
  return join(process.env.TENANT_DATA_ROOT || (existsSync("/data") ? "/data" : join(process.cwd(), "data")), ...parts);
}
export const tenantOwner = () => process.env.TENANT_OWNER_ID || "";
export const isTenantGateway = () => process.env.ACCOUNT_ISOLATION === "true" && !tenantOwner();
