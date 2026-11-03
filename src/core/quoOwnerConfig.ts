/**
 * Quo SMS credentials for CRM account workers.
 *
 * Account workers do not inherit parent business secrets (see tenantGateway
 * SHARED_ENV). Quo is Marco's business phone system (three lines on one API
 * key), so Marco and Carlos workers receive QUO_* — Wesley does not.
 */
import { getUsers } from "./users.js";

export type QuoOwnerSlug = "marco" | "carlos" | "wesley" | "other";

function firstName(user: { name: string }): string {
  return user.name.trim().split(/\s+/)[0].toLowerCase();
}

function ownerSlugFor(ownerUserId: string): QuoOwnerSlug {
  const users = getUsers();
  const me = users.find((u) => u.id === ownerUserId);
  const fromName = me ? firstName(me) : "";
  if (fromName === "marco" || fromName === "carlos" || fromName === "wesley") return fromName;
  const id = ownerUserId.trim().toLowerCase();
  if (id === "marco" || id.startsWith("marco")) return "marco";
  if (id === "carlos" || id.startsWith("carlos")) return "carlos";
  if (id === "wesley" || id.startsWith("wesley")) return "wesley";
  return "other";
}

/** True when this CRM account may use the shared Quo API key. */
export function ownerMayUseQuo(ownerUserId: string): boolean {
  const slug = ownerSlugFor(ownerUserId);
  return slug === "marco" || slug === "carlos";
}

/** Env overlay so Marco/Carlos workers can send and sync Quo SMS. */
export function quoEnvForOwner(ownerUserId: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!ownerMayUseQuo(ownerUserId)) {
    return {
      QUO_API_KEY: "",
      QUO_PHONE_NUMBER_ID: "",
      QUO_PHONE_NUMBER: "",
      QUO_API_BASE: "",
    };
  }
  return {
    QUO_API_KEY: parent.QUO_API_KEY?.trim() || "",
    QUO_PHONE_NUMBER_ID: parent.QUO_PHONE_NUMBER_ID?.trim() || "",
    QUO_PHONE_NUMBER: parent.QUO_PHONE_NUMBER?.trim() || "",
    ...(parent.QUO_API_BASE?.trim() ? { QUO_API_BASE: parent.QUO_API_BASE.trim() } : {}),
  };
}
