/**
 * The two client-facing emails: a Listing Alert digest and a Market Report.
 *
 * These go to Marco's actual clients, so they are written to survive real mail
 * clients rather than to look good in a browser: table layout, inline styles,
 * no external CSS and no web fonts. Outlook ignores <style> blocks in the head
 * and Gmail strips them on forward, which is why every rule sits on the element.
 *
 * TRACKING is the point of the feature, not a nice-to-have. Brivity's own
 * framing is that a buyer clicking into listings, or a homeowner opening their
 * report, is the "raised hand" worth calling — so every listing link goes
 * through /r/click and every message carries a 1×1 open pixel, both of which
 * land in the same engagement table the CRM reads. Links degrade safely: if
 * tracking is unreachable the redirect target is still in the URL.
 */
import type { Listing } from "./listingsStore.js";
import type { BuiltReport } from "./marketReport.js";

export function publicBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL || "https://marco-90-automation.fly.dev").trim().replace(/\/+$/, "");
}

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const money = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString();

const BRAND = "#0F766E";
const INK = "#1F2933";
const MUTED = "#6B7280";
const LINE = "#E5E7EB";

function trackedListingUrl(sendId: string, listingKey: string): string {
  return `${publicBaseUrl()}/r/click?s=${encodeURIComponent(sendId)}&l=${encodeURIComponent(listingKey)}`;
}

function pixel(sendId: string): string {
  return `<img src="${publicBaseUrl()}/r/open?s=${encodeURIComponent(sendId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" />`;
}

function shell(inner: string, sendId: string, footerNote: string): string {
  return `<div style="margin:0;padding:0;background:#F3F4F6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#FFFFFF;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${INK}">
${inner}
<tr><td style="padding:18px 24px 26px;border-top:1px solid ${LINE};color:${MUTED};font-size:12px;line-height:1.6">
  ${footerNote}
</td></tr>
</table>
</td></tr></table>
${pixel(sendId)}
</div>`;
}

function header(title: string, subtitle: string): string {
  return `<tr><td style="padding:26px 24px 8px">
  <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${BRAND};font-weight:700">Marco Puga · Real Estate</div>
  <div style="font-size:22px;font-weight:700;margin-top:8px;line-height:1.25">${esc(title)}</div>
  <div style="font-size:14px;color:${MUTED};margin-top:6px;line-height:1.5">${esc(subtitle)}</div>
</td></tr>`;
}

function listingCard(l: Listing, sendId: string, badge: string | null): string {
  const addr = [l.street, l.city].filter(Boolean).join(", ");
  const specs = [
    l.beds != null ? `${l.beds} bd` : null,
    l.baths != null ? `${l.baths} ba` : null,
    l.livingArea ? `${Math.round(l.livingArea).toLocaleString()} sqft` : null,
  ].filter(Boolean).join(" · ");
  const url = trackedListingUrl(sendId, l.listingKey);
  const photo = l.photoUrl
    ? `<a href="${url}"><img src="${esc(l.photoUrl)}" width="552" alt="${esc(addr)}" style="display:block;width:100%;max-width:552px;height:auto;border-radius:8px;border:0" /></a>`
    : "";
  const flag = badge
    ? `<span style="display:inline-block;background:${BRAND};color:#fff;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;margin-left:8px">${esc(badge)}</span>`
    : "";
  return `<tr><td style="padding:10px 24px 18px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-radius:10px">
    <tr><td style="padding:12px">
      ${photo}
      <div style="margin-top:${photo ? "12px" : "0"};font-size:19px;font-weight:700;color:${INK}">${money(l.listPrice)}${flag}</div>
      <div style="font-size:14px;margin-top:4px"><a href="${url}" style="color:${INK};text-decoration:none">${esc(addr)}</a></div>
      <div style="font-size:13px;color:${MUTED};margin-top:4px">${esc(specs)}${l.mlsNumber ? ` · MLS ${esc(l.mlsNumber)}` : ""}</div>
      <div style="margin-top:12px"><a href="${url}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;font-size:13px;font-weight:600;padding:9px 16px;border-radius:6px">View this home</a></div>
    </td></tr>
  </table>
</td></tr>`;
}

export interface AlertEmailInput {
  sendId: string;
  alertName: string;
  contactName: string | null;
  criteriaLine: string;
  /** Each listing with why it is in this email. */
  items: Array<{ listing: Listing; reason: "new" | "price_change" | "status_change" }>;
  frequencyLabel: string;
  unsubscribeUrl: string;
}

const REASON_BADGE: Record<AlertEmailInput["items"][number]["reason"], string | null> = {
  new: null,
  price_change: "Price change",
  status_change: "Status change",
};

export function renderAlertEmail(input: AlertEmailInput): { subject: string; html: string } {
  const n = input.items.length;
  const first = input.items[0]?.listing;
  const where = first ? [first.city].filter(Boolean).join("") : "";
  const subject =
    n === 1 && first
      ? `New match: ${[first.street, first.city].filter(Boolean).join(", ")} — ${money(first.listPrice)}`
      : `${n} new match${n === 1 ? "" : "es"}${where ? ` in ${where}` : ""} for “${input.alertName}”`;

  const hi = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hi,";
  const cards = input.items.map((i) => listingCard(i.listing, input.sendId, REASON_BADGE[i.reason])).join("");

  const inner =
    header(
      n === 1 ? "A new home matching your search" : `${n} new homes matching your search`,
      `${input.alertName} · ${input.criteriaLine}`,
    ) +
    `<tr><td style="padding:6px 24px 4px;font-size:14px;line-height:1.6">${esc(hi)} here's what came up since the last time I checked.</td></tr>` +
    cards +
    `<tr><td style="padding:4px 24px 20px;font-size:14px;line-height:1.6">Want to see any of these in person? Just reply to this email and I'll set it up.<br/><br/>— Marco</td></tr>`;

  const footer =
    `You're getting this because a ${esc(input.frequencyLabel)} listing alert (“${esc(input.alertName)}”) is set up for you.<br/>` +
    `<a href="${esc(input.unsubscribeUrl)}" style="color:${MUTED}">Stop these alerts</a>`;

  return { subject, html: shell(inner, input.sendId, footer) };
}

export interface ReportEmailInput {
  sendId: string;
  reportName: string;
  contactName: string | null;
  address: string;
  report: BuiltReport;
  includeHomeValue: boolean;
  /** Only on the very first send. */
  customMessage: string | null;
  frequencyLabel: string;
  unsubscribeUrl: string;
  viewUrl: string;
}

function statTile(label: string, value: string, sub: string): string {
  return `<td width="33%" style="padding:10px 8px;vertical-align:top">
    <div style="border:1px solid ${LINE};border-radius:10px;padding:12px">
      <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:700">${esc(label)}</div>
      <div style="font-size:20px;font-weight:700;margin-top:6px;color:${INK}">${esc(value)}</div>
      <div style="font-size:12px;color:${MUTED};margin-top:3px">${esc(sub)}</div>
    </div></td>`;
}

export function renderReportEmail(input: ReportEmailInput): { subject: string; html: string } {
  const r = input.report;
  const subject = `Your ${input.frequencyLabel} market update — ${input.address}`;
  const hi = input.contactName ? `Hi ${input.contactName.split(/\s+/)[0]},` : "Hi,";

  const valueBlock =
    input.includeHomeValue && r.displayValue != null
      ? `<tr><td style="padding:8px 24px 0">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:10px">
            <tr><td style="padding:16px">
              <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#047857;font-weight:700">Estimated value</div>
              <div style="font-size:30px;font-weight:800;color:#065F46;margin-top:6px">${money(r.displayValue)}</div>
              ${r.value.low != null && r.value.high != null && !r.adjusted
                ? `<div style="font-size:13px;color:#047857;margin-top:4px">Range ${money(r.value.low)} – ${money(r.value.high)}</div>` : ""}
              <div style="font-size:12px;color:#065F46;margin-top:8px;line-height:1.5">${esc(r.adjusted ? "Adjusted by Marco using local knowledge of your home and street." : r.value.basis)}</div>
            </td></tr>
          </table></td></tr>`
      : input.includeHomeValue
        ? `<tr><td style="padding:8px 24px 0;font-size:13px;color:${MUTED};line-height:1.6">${esc(r.value.basis)}</td></tr>`
        : "";

  const active = r.byStatus.find((s) => /active/i.test(s.status))?.count ?? 0;
  const pending = r.byStatus.find((s) => /pending/i.test(s.status))?.count ?? 0;

  const stats =
    `<tr><td style="padding:6px 16px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    statTile("On the market", String(active), "active listings") +
    statTile("Under contract", String(pending), "pending") +
    statTile("Median price", money(r.stats.medianPrice), r.area.label) +
    `</tr><tr>` +
    statTile("Price / sqft", r.stats.avgPricePerSqft ? "$" + r.stats.avgPricePerSqft : "—", "average asking") +
    statTile("Days on market", r.stats.avgDaysOnMarket != null ? String(r.stats.avgDaysOnMarket) : "—", "average") +
    statTile("Typical size", r.stats.avgSqft ? r.stats.avgSqft.toLocaleString() + " sqft" : "—", "average") +
    `</tr></table></td></tr>`;

  const comps = r.comps.slice(0, 3).map((l) => listingCard(l, input.sendId, null)).join("");

  const inner =
    header(`What's happening around ${input.address}`, `${r.area.label} · ${r.stats.count} listing${r.stats.count === 1 ? "" : "s"} in this snapshot`) +
    (input.customMessage
      ? `<tr><td style="padding:6px 24px 4px;font-size:14px;line-height:1.6">${esc(hi)}<br/><br/>${esc(input.customMessage)}</td></tr>`
      : `<tr><td style="padding:6px 24px 4px;font-size:14px;line-height:1.6">${esc(hi)} here's the latest on your neighbourhood.</td></tr>`) +
    valueBlock +
    stats +
    (comps ? `<tr><td style="padding:14px 24px 0;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">Nearby right now</td></tr>${comps}` : "") +
    `<tr><td style="padding:4px 24px 20px;font-size:14px;line-height:1.6">
      <a href="${esc(input.viewUrl)}" style="display:inline-block;background:${BRAND};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 18px;border-radius:6px">See the full report</a>
      <div style="margin-top:16px">Curious what this means for your plans? Reply any time.<br/><br/>— Marco</div>
    </td></tr>`;

  /* The provenance line is not decoration: a homeowner deciding whether to sell
     deserves to know these are asking prices on live listings, not solds. */
  const footer =
    `${esc(r.notes.join(" "))}<br/><br/>` +
    `You're getting this because a ${esc(input.frequencyLabel)} market report (“${esc(input.reportName)}”) is set up for you.<br/>` +
    `<a href="${esc(input.unsubscribeUrl)}" style="color:${MUTED}">Stop these updates</a>`;

  return { subject, html: shell(inner, input.sendId, footer) };
}
