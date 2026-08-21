/**
 * The two pages a CLIENT sees, outside the CRM and without logging in: the
 * listing an alert email links to, and the full market report.
 *
 * Server-rendered, self-contained, no framework — same reasoning as the emails.
 * These are the only surfaces in this system a member of the public can reach,
 * so they render property data and nothing else: no contact details, no lead
 * record, no CRM navigation.
 */
import type { Listing } from "./listingsStore.js";
import type { BuiltReport } from "./marketReport.js";
import type { MarketReport } from "./outreachStore.js";
import { esc } from "./outreachEmail.js";

const money = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString();

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:#1F2933;background:#F3F4F6;line-height:1.6}
.wrap{max-width:860px;margin:0 auto;padding:24px 18px 60px}
.brand{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#0F766E;font-weight:800}
.card{background:#fff;border-radius:14px;padding:22px;margin-top:16px;box-shadow:0 1px 3px rgba(16,24,40,.08)}
h1{font-size:26px;line-height:1.25;margin:10px 0 4px}
h2{font-size:15px;letter-spacing:.06em;text-transform:uppercase;color:#6B7280;margin:0 0 12px}
.sub{color:#6B7280;font-size:15px;margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{border:1px solid #E5E7EB;border-radius:10px;padding:14px}
.tile .l{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6B7280;font-weight:700}
.tile .v{font-size:22px;font-weight:700;margin-top:6px}
.tile .s{font-size:12px;color:#6B7280}
.value{background:#ECFDF5;border:1px solid #A7F3D0;border-radius:12px;padding:20px}
.value .big{font-size:38px;font-weight:800;color:#065F46;margin:6px 0 2px}
.value .rng{color:#047857;font-size:14px}
.value .basis{color:#065F46;font-size:13px;margin-top:10px}
.homes{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.home{border:1px solid #E5E7EB;border-radius:10px;overflow:hidden;background:#fff}
.home img{display:block;width:100%;height:160px;object-fit:cover;background:#E5E7EB}
.home .b{padding:12px}
.home .p{font-weight:700;font-size:17px}
.home .a{font-size:13px;color:#374151;margin-top:2px}
.home .s{font-size:12px;color:#6B7280;margin-top:4px}
.note{font-size:13px;color:#6B7280;margin-top:14px;padding-top:14px;border-top:1px solid #E5E7EB}
.hero{width:100%;max-height:420px;object-fit:cover;border-radius:12px;display:block;background:#E5E7EB}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{background:#F3F4F6;border-radius:999px;padding:5px 12px;font-size:13px;color:#374151}
.cta{display:inline-block;background:#0F766E;color:#fff;text-decoration:none;font-weight:600;
  padding:12px 20px;border-radius:8px;margin-top:16px}
.rmk{color:#374151;font-size:14px;margin-top:14px;white-space:pre-wrap}
@media (prefers-color-scheme: dark){}
`;

export function publicShell(title: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card"><h1>${esc(title)}</h1><p class="sub">${esc(detail)}</p></div>
</div></body></html>`;
}

export function renderPublicListing(l: Listing & { raw?: unknown }): string {
  const addr = [l.street, l.city, l.state].filter(Boolean).join(", ");
  const raw = (l.raw && typeof l.raw === "object" ? l.raw : {}) as Record<string, unknown>;
  const prop = (raw.property && typeof raw.property === "object" ? raw.property : {}) as Record<string, unknown>;
  const school = (raw.school && typeof raw.school === "object" ? raw.school : {}) as Record<string, unknown>;
  const photos = Array.isArray(raw.photos) ? (raw.photos as unknown[]).filter((p): p is string => typeof p === "string") : [];

  const chip = (v: unknown, label: string) =>
    v == null || v === "" ? "" : `<span class="chip">${esc(label)}: ${esc(v)}</span>`;

  const gallery = photos.slice(1, 7).map(
    (p) => `<img src="${esc(p)}" alt="" style="width:100%;height:150px;object-fit:cover;border-radius:8px" loading="lazy">`,
  ).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(addr)} — ${esc(money(l.listPrice))}</title><style>${CSS}</style></head>
<body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card">
  ${l.photoUrl ? `<img class="hero" src="${esc(l.photoUrl)}" alt="${esc(addr)}">` : ""}
  <h1 style="margin-top:16px">${esc(money(l.listPrice))}</h1>
  <p class="sub">${esc(addr)}${l.postalCode ? " " + esc(l.postalCode) : ""}</p>
  <div class="chips">
    ${chip(l.beds, "Beds")}${chip(l.baths, "Baths")}
    ${l.livingArea ? `<span class="chip">${Math.round(l.livingArea).toLocaleString()} sqft</span>` : ""}
    ${chip(l.yearBuilt, "Built")}${chip(prop.stories, "Storeys")}
    ${String(prop.pool || "").toUpperCase() === "Y" ? `<span class="chip">Pool</span>` : ""}
    ${chip(l.subdivision, "Subdivision")}${chip(school.district, "Schools")}
    ${chip(l.status, "Status")}${l.mlsNumber ? `<span class="chip">MLS ${esc(l.mlsNumber)}</span>` : ""}
  </div>
  ${l.publicRemarks ? `<div class="rmk">${esc(l.publicRemarks)}</div>` : ""}
  <a class="cta" href="mailto:?subject=${encodeURIComponent("About " + addr)}">Ask Marco about this home</a>
  ${gallery ? `<div class="homes" style="margin-top:18px">${gallery}</div>` : ""}
  <div class="note">Listing data from the San Antonio Board of REALTORS, last refreshed ${esc(
    (l.modificationTs || l.syncedAt || "").slice(0, 10),
  )}. ${l.listOffice ? "Listed by " + esc(l.listOffice) + "." : ""} Marco Puga is not necessarily the listing agent.</div>
</div></div></body></html>`;
}

export function renderPublicReport(report: MarketReport, built: BuiltReport): string {
  const r = built;
  const active = r.byStatus.find((s) => /active/i.test(s.status))?.count ?? 0;
  const pending = r.byStatus.find((s) => /pending/i.test(s.status))?.count ?? 0;

  const tile = (l: string, v: string, s: string) =>
    `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

  const homes = r.comps.slice(0, 9).map((l) => `
    <a class="home" href="/l/${encodeURIComponent(l.listingKey)}" style="text-decoration:none;color:inherit">
      ${l.photoUrl ? `<img src="${esc(l.photoUrl)}" alt="" loading="lazy">` : ""}
      <div class="b">
        <div class="p">${esc(money(l.listPrice))}</div>
        <div class="a">${esc([l.street, l.city].filter(Boolean).join(", "))}</div>
        <div class="s">${esc([
          l.beds != null ? `${l.beds} bd` : "",
          l.baths != null ? `${l.baths} ba` : "",
          l.livingArea ? `${Math.round(l.livingArea).toLocaleString()} sqft` : "",
        ].filter(Boolean).join(" · "))}</div>
      </div></a>`).join("");

  const valueCard =
    report.includeHomeValue && r.displayValue != null
      ? `<div class="card"><div class="value">
          <div class="l" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#047857;font-weight:800">Estimated value</div>
          <div class="big">${esc(money(r.displayValue))}</div>
          ${r.value.low != null && r.value.high != null && !r.adjusted
            ? `<div class="rng">Range ${esc(money(r.value.low))} – ${esc(money(r.value.high))}</div>` : ""}
          <div class="basis">${esc(r.adjusted
            ? "Adjusted by Marco using local knowledge of this home and street."
            : r.value.basis)}</div>
        </div></div>`
      : report.includeHomeValue
        ? `<div class="card"><p class="sub">${esc(r.value.basis)}</p></div>`
        : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market report — ${esc(report.address)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card">
  <h1>${esc(report.address)}</h1>
  <p class="sub">${esc(r.area.label)} · ${r.stats.count} listing${r.stats.count === 1 ? "" : "s"} in this snapshot · updated ${esc(r.builtAt.slice(0, 10))}</p>
</div>
${valueCard}
<div class="card">
  <h2>The market around you</h2>
  <div class="grid">
    ${tile("On the market", String(active), "active listings")}
    ${tile("Under contract", String(pending), "pending")}
    ${tile("Median asking", money(r.stats.medianPrice), r.area.label)}
    ${tile("Price / sqft", r.stats.avgPricePerSqft ? "$" + r.stats.avgPricePerSqft : "—", "average asking")}
    ${tile("Days on market", r.stats.avgDaysOnMarket != null ? String(r.stats.avgDaysOnMarket) : "—", "average")}
    ${tile("Typical size", r.stats.avgSqft ? r.stats.avgSqft.toLocaleString() + " sqft" : "—", "average")}
  </div>
</div>
${homes ? `<div class="card"><h2>On the market nearby</h2><div class="homes">${homes}</div></div>` : ""}
<div class="card">
  <div class="note" style="margin:0;padding:0;border:0">${esc(r.notes.join(" "))}
  Figures are asking prices on live listings from the San Antonio Board of REALTORS, not an appraisal.
  Want a proper valuation on this home? Reply to Marco's email any time.</div>
</div>
</div></body></html>`;
}

/**
 * The client-facing CMA — what step 7 publishes.
 *
 * Same rules as the market report page, plus one specific to this document: a
 * CMA is a pricing opinion a seller may act on, so the page states what the
 * number is built from and, where the data is thin, says so on the page rather
 * than only in the CRM. A seller reading "estimated value" is entitled to know
 * that it came from four comparables and no solds, if that is the case.
 */
export function renderPublicCma(
  session: import("./cmaStore.js").CmaSession,
  comps: import("./cmaStore.js").CmaComparable[],
  results: import("./cmaComps.js").CmaResults,
): string {
  const statusName: Record<string, string> = {
    ACTIVE: "For sale now",
    PENDING: "Under contract",
    SOLD: "Sold",
    OFF_MKT: "Came off the market",
  };

  const tile = (l: string, v: string, s: string) =>
    `<div class="tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

  const bucketTiles = results.buckets
    .filter((b) => b.count > 0)
    .map((b) =>
      tile(
        statusName[b.status] || b.label,
        b.medianPrice == null ? "—" : money(b.medianPrice),
        `${b.count} compared${b.listToSalePct != null ? ` · sold at ${Math.round(b.listToSalePct)}% of asking` : ""}`,
      ),
    )
    .join("");

  const compCard = (c: import("./cmaStore.js").CmaComparable) => {
    const price = c.listingStatus === "SOLD" ? c.soldPrice ?? c.price : c.price;
    const specs = [
      c.beds != null ? `${c.beds} bd` : "",
      c.baths != null ? `${c.baths} ba` : "",
      c.sqft ? `${Math.round(c.sqft).toLocaleString()} sqft` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    /* A sold row shows both numbers when both exist. One number labelled
       "sold" that is actually the asking price is the error this guards. */
    const dual =
      c.listingStatus === "SOLD" && c.originalListPrice && c.soldPrice
        ? `<div class="s">Asked ${esc(money(c.originalListPrice))} · sold ${esc(money(c.soldPrice))}</div>`
        : "";
    /* MLS photo URLs do go missing, and a broken-image glyph on a document a
       seller is reading is worse than no photo at all — the card degrades to
       text rather than showing the browser's placeholder. */
    return `<div class="home">
      ${c.photoUrl ? `<img src="${esc(c.photoUrl)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <div class="b">
        <div class="p">${esc(money(price))}</div>
        <div class="a">${esc(c.address)}</div>
        ${specs ? `<div class="s">${esc(specs)}</div>` : ""}
        ${dual}
        <div class="s">${esc(statusName[c.listingStatus] || c.listingStatus)}</div>
      </div></div>`;
  };

  const groups = (["SOLD", "PENDING", "ACTIVE", "OFF_MKT"] as const)
    .map((st) => {
      const rows = comps.filter((c) => c.listingStatus === st);
      if (!rows.length) return "";
      return `<div class="card"><h2>${esc(statusName[st])}</h2>
        <div class="homes">${rows.map(compCard).join("")}</div></div>`;
    })
    .join("");

  const valueCard =
    results.estimate != null
      ? `<div class="card"><div class="value">
          <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#047857;font-weight:800">Indicated value</div>
          <div class="big">${esc(money(results.estimate))}</div>
          ${results.estimateLow != null && results.estimateHigh != null
            ? `<div class="rng">Range ${esc(money(results.estimateLow))} – ${esc(money(results.estimateHigh))}</div>`
            : ""}
          <div class="basis">${esc(
            `Based on ${results.sizedCount} comparable home${results.sizedCount === 1 ? "" : "s"}` +
              (results.pricePerSqft != null ? ` at a median of $${results.pricePerSqft.toFixed(0)} per square foot` : "") +
              (session.subjectSqft ? `, applied to ${session.subjectSqft.toLocaleString()} sqft.` : ".") +
              (results.sizedCount < results.totalSelected
                ? ` ${results.totalSelected} homes were compared in total; the rest had no square footage on file.`
                : ""),
          )}</div>
        </div></div>`
      : `<div class="card"><p class="sub">${esc(
          results.estimateBlockedReason ||
            "There is no value figure on this report yet.",
        )}</p></div>`;

  const subjectLine = [
    session.subjectBeds != null ? `${session.subjectBeds} beds` : "",
    session.subjectBaths != null ? `${session.subjectBaths} baths` : "",
    session.subjectSqft ? `${session.subjectSqft.toLocaleString()} sqft` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comparative market analysis — ${esc(session.subjectAddress)}</title>
<style>${CSS}</style></head>
<body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card">
  <h1>${esc(session.subjectAddress)}</h1>
  <p class="sub">Comparative market analysis prepared for ${esc(session.clientName)}${
    subjectLine ? ` · ${esc(subjectLine)}` : ""
  }${session.publishedAt ? ` · ${esc(session.publishedAt.slice(0, 10))}` : ""}</p>
</div>
${valueCard}
${bucketTiles ? `<div class="card"><h2>What the comparables show</h2><div class="grid">${bucketTiles}</div></div>` : ""}
${groups}
<div class="card">
  <div class="note" style="margin:0;padding:0;border:0">${esc(results.notes.join(" "))}
  Comparables are chosen by Marco, not by an algorithm. This is a pricing opinion, not an appraisal, and it is
  not a guarantee of what the home will sell for. Questions about any home on this page? Reply to Marco any time.</div>
</div>
</div></body></html>`;
}
