import type { CRMUser } from "./types.js";
import { getAccountUserById } from "./users.js";
export const memberName = (user: CRMUser) => user.name.trim().split(/\s+/)[0].toLowerCase();
export function canViewWorkspace(actor: CRMUser | null, owner: string): boolean {
  if (!actor?.active) return false;
  if (actor.id === owner) return true;
  const target = getAccountUserById(owner);
  return memberName(actor) === "carlos" && !!target?.active && ["marco","wesley"].includes(memberName(target));
}
// Cross-workspace access is deliberately read-only. In particular, never invoke
// callbacks, browser actions, integrations or agents through a GET side effect.
export function workspaceReadAllowed(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (!path.startsWith("/api/")) return !/oauth|callback/i.test(path);
  return /^\/api\/(settings\/(command|layout)|dashboard\/data|tasks(?:\/[^/]+)?|marco-tasks|crm-tasks|users|team\/roster|harvey\/(models|conversations(?:\/[^/]+)?|projects(?:\/[^/]+)?|work\/(status|logins|plugins|schedules|browser\/[^/]+\/preview|files\/[^/]+(?:\/[^/]+)?)))$/.test(path);
}
