import { createHash } from "crypto";
import { get, list, put } from "./store.js";

const SDK = new Function("return import('@composio/core')");
let clientPromise: Promise<any>;
const sessions = new Map<string, Promise<any>>();
const META = new Set([
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_WAIT_FOR_CONNECTIONS",
]);

export function composioReady() {
  return !!process.env.COMPOSIO_API_KEY?.trim();
}
export function composioUser(owner: string, project: string | null) {
  return "harvey_" + createHash("sha256").update(JSON.stringify([owner, project])).digest("hex");
}
async function client() {
  if (!composioReady()) throw new Error("Managed connections are not configured yet");
  return (clientPromise ||= SDK().then(({ Composio }: any) => new Composio({ apiKey: process.env.COMPOSIO_API_KEY })));
}
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e: any) {
    const message = String(e.message || "Connection request failed")
      .split(process.env.COMPOSIO_API_KEY || "\0")
      .join("[redacted]");
    throw new Error(message.slice(0, 500));
  }
}
export async function composioSession(owner: string, project: string | null) {
  if (project) get("project", owner, project);
  const key = composioUser(owner, project);
  if (!sessions.has(key))
    sessions.set(
      key,
      guarded(async () => {
        const c = await client(),
          saved = list<any>("composio_session", owner).find((s) => s.id === key);
        if (saved) return c.sessions.use(saved.sessionId);
        const s = await c.sessions.create(key, {
          manageConnections: {
            callbackUrl: new URL(
              "/harvey?plugins=1&project=" + encodeURIComponent(project || ""),
              process.env.HARVEY_PUBLIC_URL || "http://localhost:3000",
            ).href,
          },
        });
        put("composio_session", owner, { id: key, sessionId: s.sessionId, projectId: project });
        return s;
      }).catch((e) => {
        sessions.delete(key);
        throw e;
      }),
    );
  return sessions.get(key)!;
}
// Existing project connections remain usable; new sign-ins belong to the owner.
function scopes(owner: string) {
  const projects = new Set(list<any>("project", owner).map((p) => p.id));
  return [
    null,
    ...new Set(
      list<any>("composio_session", owner)
        .map((s) => s.projectId)
        .filter((p) => p && projects.has(p)),
    ),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Prefer a human label (alias / email) so multiple Gmail accounts stay distinct. */
export function accountLabel(account: {
  alias?: string | null;
  id?: string;
  data?: unknown;
  params?: unknown;
  state?: unknown;
}): string {
  const alias = pickString(account.alias);
  if (alias) return alias;
  const bags = [asRecord(account.data), asRecord(account.params), asRecord(account.state)].filter(
    Boolean,
  ) as Record<string, unknown>[];
  for (const bag of bags) {
    const nested = asRecord(bag.user) || asRecord(bag.profile) || asRecord(bag.account);
    const label = pickString(
      bag.email,
      bag.user_email,
      bag.userEmail,
      bag.username,
      bag.user_name,
      bag.name,
      nested?.email,
      nested?.username,
      nested?.name,
    );
    if (label) return label;
  }
  const id = String(account.id || "").trim();
  return id ? `Account ${id.slice(0, 8)}` : "Connected account";
}

function titleCaseSlug(slug: string): string {
  return String(slug || "")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * One row per connected account (not per toolkit). Multiple Gmail / Drive
 * logins under the same owner appear as separate rows.
 */
export async function managedConnections(owner: string) {
  if (!composioReady()) return [];
  const c = await client();
  const all: any[] = [];
  const logos = new Map<string, { name: string; logo?: string }>();

  for (const project of scopes(owner)) {
    const userId = composioUser(owner, project);
    // Warm session so Tool Router stays aligned with this user id.
    await composioSession(owner, project);
    let cursor: string | undefined;
    do {
      const page = await c.connectedAccounts.list({
        userIds: [userId],
        statuses: ["ACTIVE"],
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      const items = Array.isArray(page?.items) ? page.items : [];
      for (const account of items) {
        if (account?.isDisabled) continue;
        if (String(account?.status || "").toUpperCase() !== "ACTIVE") continue;
        const slug = String(account?.toolkit?.slug || "").toLowerCase();
        if (!slug) continue;
        const accountId = String(account.id || "");
        if (!accountId) continue;
        const meta = logos.get(slug);
        all.push({
          slug,
          name: meta?.name || titleCaseSlug(slug),
          logo: meta?.logo || null,
          scope: userId,
          accountId,
          alias: account.alias || null,
          label: accountLabel(account),
          connection: {
            isActive: true,
            connectedAccount: { id: accountId, status: account.status },
          },
        });
      }
      cursor = page?.nextCursor || page?.cursor || undefined;
      if (!items.length) break;
    } while (cursor);
  }

  // Enrich names/logos for only the connected toolkits.
  if (all.length) {
    try {
      const session = await composioSession(owner, null);
      const slugs = [...new Set(all.map((row) => row.slug))];
      const page = await session.toolkits({ toolkits: slugs, limit: Math.max(slugs.length, 1) });
      for (const toolkit of page.items || []) {
        const slug = String(toolkit.slug || "").toLowerCase();
        if (!slug) continue;
        logos.set(slug, {
          name: String(toolkit.name || titleCaseSlug(slug)),
          logo: toolkit.logo,
        });
      }
      for (const row of all) {
        const meta = logos.get(row.slug);
        if (!meta) continue;
        row.name = meta.name;
        row.logo = meta.logo || row.logo;
      }
    } catch {
      /* Labels already have a slug fallback. */
    }
  }

  return all;
}

export async function managedCatalog(
  owner: string,
  project: string | null,
  search = "",
  cursor?: string,
) {
  if (project) get("project", owner, project);
  if (!composioReady()) return { enabled: false, items: [], connected: [] };
  return guarded(async () => {
    const session = await composioSession(owner, null);
    const [catalog, connected] = await Promise.all([
      session.toolkits({
        limit: 50,
        ...(search.trim() ? { search: search.trim().slice(0, 100) } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      managedConnections(owner),
    ]);
    const connectedSlugs = new Set(connected.map((c) => c.slug));
    const items = (catalog.items || []).map((item: any) => ({
      ...item,
      connection: {
        ...(item.connection || {}),
        isActive: !!(item.connection?.isActive || connectedSlugs.has(String(item.slug || "").toLowerCase())),
      },
    }));
    return {
      enabled: true,
      items,
      cursor: catalog.nextCursor || catalog.cursor || null,
      connected,
    };
  });
}

export async function connectManaged(
  owner: string,
  project: string | null,
  slug: string,
  callbackPath?: string,
) {
  if (!/^[a-z0-9_-]{1,80}$/.test(slug)) throw new Error("Invalid service");
  return guarded(async () => {
    if (project) get("project", owner, project);
    // Keep the Tool Router session warm for discovery after OAuth returns.
    await composioSession(owner, null);
    const c = await client();
    const userId = composioUser(owner, null);
    const path = callbackPath?.startsWith("/")
      ? callbackPath
      : `/harvey?plugins=1&project=${encodeURIComponent(project || "")}`;
    const callbackUrl = new URL(
      path,
      process.env.HARVEY_PUBLIC_URL || "http://localhost:3000",
    ).href;

    let authConfigId = (await c.authConfigs.list({ toolkit: slug })).items?.[0]?.id;
    if (!authConfigId) {
      try {
        authConfigId = (
          await c.authConfigs.create(slug, {
            type: "use_composio_managed_auth",
            name: `${titleCaseSlug(slug)} Auth Config`,
          })
        ).id;
      } catch (error: any) {
        // Fall back to session authorize when auth-config create is unavailable.
        const connection = await (await composioSession(owner, null)).authorize(slug, {
          callbackUrl,
          alias: `${slug}-${Date.now().toString(36)}`,
        });
        if (!connection?.redirectUrl) throw error;
        return { url: connection.redirectUrl };
      }
    }

    // allowMultiple: true is what lets a second Gmail / Drive account connect.
    const connection = await c.connectedAccounts.link(userId, authConfigId, {
      allowMultiple: true,
      callbackUrl,
      alias: `${slug}-${Date.now().toString(36)}`,
    });
    if (!connection?.redirectUrl) throw new Error("The service did not return a sign-in link");
    return { url: connection.redirectUrl };
  });
}

/** Run a toolkit action (e.g. GOOGLEDRIVE_FIND_FILE) inside the owner's Composio session. */
export async function executeToolkit(
  owner: string,
  toolSlug: string,
  args: Record<string, unknown> = {},
  project: string | null = null,
): Promise<unknown> {
  if (!/^[A-Z0-9_]{3,120}$/.test(toolSlug)) throw new Error("Invalid toolkit action");
  if (project) get("project", owner, project);
  return guarded(async () => {
    const session = await composioSession(owner, project);
    const result = await session.execute(toolSlug, args);
    if (result?.error) {
      throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
    }
    return result?.data !== undefined ? result.data : result;
  });
}

export function connectedToolkit(
  connections: Awaited<ReturnType<typeof managedConnections>>,
  slug: string,
): any | null {
  const want = slug.toLowerCase();
  return connections.find((t) => String(t.slug || "").toLowerCase() === want) || null;
}

export async function disconnectManaged(
  owner: string,
  project: string | null,
  slug: string,
  scope?: string,
  accountId?: string,
) {
  if (project) get("project", owner, project);
  return guarded(async () => {
    const matches = (await managedConnections(owner)).filter(
      (t) =>
        t.slug === slug &&
        (!scope || t.scope === scope) &&
        (!accountId || t.accountId === accountId),
    );
    if (!matches.length) throw new Error("No connected account found");
    const c = await client();
    for (const found of matches) {
      const id = found.accountId || found.connection?.connectedAccount?.id;
      if (id) await c.connectedAccounts.delete(id);
    }
    sessions.clear();
    return { ok: true };
  });
}

export async function managedTools(owner: string, project: string | null) {
  if (project) get("project", owner, project);
  if (!composioReady()) return [];
  return guarded(async () => {
    const session = await composioSession(owner, null);
    return (await session.tools())
      .filter((t: any) => META.has(t.function?.name))
      .map((t: any) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: {
          ...t.function.parameters,
          properties: {
            ...t.function.parameters.properties,
            harvey_connection_scope: {
              type: "string",
              description:
                "Use the scope from the connected apps list for this service. Omit for new sign-ins.",
              enum: scopes(owner).map((p) => composioUser(owner, p)),
            },
          },
        },
      }));
  });
}

export async function executeManaged(
  owner: string,
  project: string | null,
  name: string,
  input: any,
) {
  if (project) get("project", owner, project);
  if (!META.has(name)) throw new Error("Unsupported managed tool");
  const args = { ...input };
  const scope = args.harvey_connection_scope;
  delete args.harvey_connection_scope;
  delete args.session_id;
  delete args.user_id;
  const allowed = scopes(owner);
  let selected: string | null = null;
  if (scope) {
    const index = allowed.findIndex((p) => composioUser(owner, p) === scope);
    if (index < 0) throw new Error("Unknown connection scope");
    selected = allowed[index];
  } else if (
    name !== "COMPOSIO_MANAGE_CONNECTIONS" &&
    name !== "COMPOSIO_WAIT_FOR_CONNECTIONS"
  ) {
    const connectedScopes = [...new Set((await managedConnections(owner)).map((c) => c.scope))];
    // Never silently route a tool to an arbitrary project's account.
    if (connectedScopes.length > 1)
      throw new Error(
        "Multiple connection scopes are active. Set harvey_connection_scope from the connected apps list for discovery and execution.",
      );
    if (connectedScopes.length === 1)
      selected = allowed.find((p) => composioUser(owner, p) === connectedScopes[0]) || null;
  }
  return guarded(async () => {
    const session = await composioSession(owner, selected);
    const result = await session.execute(name, args);
    if (result.error)
      throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
    return result.data;
  });
}
