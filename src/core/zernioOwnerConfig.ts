/**
 * Per-account Zernio credentials for Marco and Wesley on the shared Command
 * Center host. Account workers do not inherit parent business secrets (see
 * tenantGateway SHARED_ENV), so each owner's key/account id is resolved here
 * and injected into that worker's environment.
 *
 * Marco uses the existing ZERNIO_* names. Wesley uses WESLEY_ZERNIO_* so the
 * two Zernio profiles never share a key by accident.
 */
import { getUsers } from "./users.js";
import { tenantOwner } from "./tenantData.js";

export type ZernioOwnerSlug = "marco" | "wesley";

export interface ZernioOwnerSecrets {
  ownerSlug: ZernioOwnerSlug;
  ownerUserId: string | null;
  apiKey: string;
  webhookSecret: string;
  tiktokAccountId: string;
}

function firstName(user: { name: string }): string {
  return user.name.trim().split(/\s+/)[0].toLowerCase();
}

function findUserId(slug: ZernioOwnerSlug): string | null {
  const hit = getUsers().find((u) => firstName(u) === slug && u.active !== false);
  return hit?.id || null;
}

export function marcoZernioSecrets(env: NodeJS.ProcessEnv = process.env): ZernioOwnerSecrets {
  return {
    ownerSlug: "marco",
    ownerUserId: findUserId("marco"),
    apiKey: env.ZERNIO_DM_API_KEY?.trim() || env.ZERNIO_API_KEY?.trim() || "",
    webhookSecret: env.ZERNIO_WEBHOOK_SECRET?.trim() || "",
    tiktokAccountId: env.ZERNIO_TIKTOK_ACCOUNT_ID?.trim() || "",
  };
}

export function wesleyZernioSecrets(env: NodeJS.ProcessEnv = process.env): ZernioOwnerSecrets {
  return {
    ownerSlug: "wesley",
    ownerUserId: findUserId("wesley"),
    apiKey: env.WESLEY_ZERNIO_DM_API_KEY?.trim() || "",
    webhookSecret: env.WESLEY_ZERNIO_WEBHOOK_SECRET?.trim() || "",
    tiktokAccountId: env.WESLEY_ZERNIO_TIKTOK_ACCOUNT_ID?.trim() || "",
  };
}

export function allZernioOwnerSecrets(env: NodeJS.ProcessEnv = process.env): ZernioOwnerSecrets[] {
  return [marcoZernioSecrets(env), wesleyZernioSecrets(env)].filter((s) => s.apiKey || s.webhookSecret || s.tiktokAccountId);
}

/** Resolve secrets for the current process (account worker or single-tenant). */
export function currentZernioSecrets(env: NodeJS.ProcessEnv = process.env): ZernioOwnerSecrets {
  const owner = tenantOwner();
  if (owner) {
    const users = getUsers();
    const me = users.find((u) => u.id === owner);
    const slug = me ? firstName(me) : "";
    if (slug === "wesley") return wesleyZernioSecrets(env);
    if (slug === "marco") return marcoZernioSecrets(env);
  }
  // Parent / non-isolated: prefer Marco's keys (historical default).
  return marcoZernioSecrets(env);
}

export function zernioSecretsForTikTokAccount(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): ZernioOwnerSecrets | null {
  const id = String(accountId || "").trim();
  if (!id) return null;
  for (const s of allZernioOwnerSecrets(env)) {
    if (s.tiktokAccountId && s.tiktokAccountId === id) return s;
  }
  return null;
}

function ownerSlugFor(ownerUserId: string): ZernioOwnerSlug | null {
  const users = getUsers();
  const me = users.find((u) => u.id === ownerUserId);
  const fromName = me ? firstName(me) : "";
  if (fromName === "wesley" || fromName === "marco") return fromName;
  // Fixture / fallback ids are often just "wesley" / "marco".
  const id = ownerUserId.trim().toLowerCase();
  if (id === "wesley" || id.startsWith("wesley")) return "wesley";
  if (id === "marco" || id.startsWith("marco")) return "marco";
  return null;
}

/** Env overlay injected into an account worker so its Zernio client sees only that owner's keys. */
export function zernioEnvForOwner(ownerUserId: string, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const slug = ownerSlugFor(ownerUserId);
  const secrets = slug === "wesley" ? wesleyZernioSecrets(parent) : marcoZernioSecrets(parent);
  const isWesley = secrets.ownerSlug === "wesley";
  return {
    ZERNIO_DM_API_KEY: secrets.apiKey || "",
    ZERNIO_API_KEY: secrets.apiKey || "",
    ZERNIO_WEBHOOK_SECRET: secrets.webhookSecret || "",
    ZERNIO_TIKTOK_ACCOUNT_ID: secrets.tiktokAccountId || "",
    // Prevent Wesley workers from accidentally reading Marco's parent names.
    WESLEY_ZERNIO_DM_API_KEY: isWesley ? secrets.apiKey : "",
    WESLEY_ZERNIO_WEBHOOK_SECRET: isWesley ? secrets.webhookSecret : "",
    WESLEY_ZERNIO_TIKTOK_ACCOUNT_ID: isWesley ? secrets.tiktokAccountId : "",
  };
}
