/**
 * Inbound website lead form posts.
 *
 * Mirrors the Mojo webhook pattern: a push endpoint that creates or enriches a
 * lead through the quiet path. There is no bulk pull from the public site —
 * the form posts one contact at a time.
 *
 * Closed unless WEBSITE_WEBHOOK_SECRET is set. Compared in constant time against
 * a SHA-256 digest (query `token` or `x-website-secret` header).
 */
import { createHash, timingSafeEqual } from "crypto";

import type { Lead } from "./types.js";

export interface WebsiteWebhookPayload {
  id?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  full_name?: unknown;
  name?: unknown;
  phone?: unknown;
  phone_number?: unknown;
  email?: unknown;
  email_address?: unknown;
  address?: unknown;
  street?: unknown;
  city?: unknown;
  state?: unknown;
  postal_code?: unknown;
  zip?: unknown;
  message?: unknown;
  notes?: unknown;
  note?: unknown;
  source?: unknown;
  [k: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function pick(p: WebsiteWebhookPayload, keys: string[]): string {
  for (const k of keys) {
    const v = str(p[k]);
    if (v) return v;
  }
  return "";
}

export function websitePhone(raw: unknown): string | null {
  let d = str(raw).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export interface MappedWebsiteLead {
  externalId: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  source: string;
  notes: string | null;
  tags: string[];
}

/** Source is always `"Website"` so sidebar counts stay one bucket. */
export function mapWebsitePayload(p: WebsiteWebhookPayload): MappedWebsiteLead {
  const first = pick(p, ["first_name"]);
  const last = pick(p, ["last_name"]);
  const name = pick(p, ["full_name", "name"]) || [first, last].filter(Boolean).join(" ").trim();
  const phone = websitePhone(pick(p, ["phone", "phone_number"]));
  const email = pick(p, ["email", "email_address"]).toLowerCase() || null;
  const street = pick(p, ["address", "street"]);
  const address =
    [street, pick(p, ["city"]), pick(p, ["state"]), pick(p, ["postal_code", "zip"])]
      .filter(Boolean)
      .join(", ") || null;
  return {
    externalId: pick(p, ["id"]) || null,
    name: name || phone || email || "Unnamed Website lead",
    phone,
    email,
    address,
    source: "Website",
    notes: pick(p, ["notes", "note", "message"]) || null,
    tags: ["Website"],
  };
}

export function websitePayloadIsUsable(m: MappedWebsiteLead): boolean {
  return Boolean(m.phone || m.email);
}

export function websiteSecretConfigured(): boolean {
  return Boolean(process.env.WEBSITE_WEBHOOK_SECRET?.trim());
}

export function websiteSecretOk(provided: string | undefined): boolean {
  const expected = process.env.WEBSITE_WEBHOOK_SECRET?.trim();
  if (!expected) return false;
  const a = createHash("sha256").update(String(provided ?? "")).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function websiteLeadPatch(m: MappedWebsiteLead): Partial<Lead> {
  const patch: Partial<Lead> = {
    name: m.name,
    phone: m.phone,
    email: m.email,
    source: m.source,
  };
  if (m.address) patch.address = m.address;
  if (m.notes) patch.crmNotes = m.notes;
  if (m.tags.length) patch.tags = m.tags;
  return patch;
}
