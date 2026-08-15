"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicShell = publicShell;
exports.renderPublicListing = renderPublicListing;
exports.renderPublicReport = renderPublicReport;
const outreachEmail_js_1 = require("./outreachEmail.js");
const money = (n) => n == null || !Number.isFinite(n) ? "—" : "$" + Math.round(n).toLocaleString();
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
function publicShell(title, detail) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${(0, outreachEmail_js_1.esc)(title)}</title>
<style>${CSS}</style></head><body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card"><h1>${(0, outreachEmail_js_1.esc)(title)}</h1><p class="sub">${(0, outreachEmail_js_1.esc)(detail)}</p></div>
</div></body></html>`;
}
function renderPublicListing(l) {
    const addr = [l.street, l.city, l.state].filter(Boolean).join(", ");
    const raw = (l.raw && typeof l.raw === "object" ? l.raw : {});
    const prop = (raw.property && typeof raw.property === "object" ? raw.property : {});
    const school = (raw.school && typeof raw.school === "object" ? raw.school : {});
    const photos = Array.isArray(raw.photos) ? raw.photos.filter((p) => typeof p === "string") : [];
    const chip = (v, label) => v == null || v === "" ? "" : `<span class="chip">${(0, outreachEmail_js_1.esc)(label)}: ${(0, outreachEmail_js_1.esc)(v)}</span>`;
    const gallery = photos.slice(1, 7).map((p) => `<img src="${(0, outreachEmail_js_1.esc)(p)}" alt="" style="width:100%;height:150px;object-fit:cover;border-radius:8px" loading="lazy">`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${(0, outreachEmail_js_1.esc)(addr)} — ${(0, outreachEmail_js_1.esc)(money(l.listPrice))}</title><style>${CSS}</style></head>
<body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card">
  ${l.photoUrl ? `<img class="hero" src="${(0, outreachEmail_js_1.esc)(l.photoUrl)}" alt="${(0, outreachEmail_js_1.esc)(addr)}">` : ""}
  <h1 style="margin-top:16px">${(0, outreachEmail_js_1.esc)(money(l.listPrice))}</h1>
  <p class="sub">${(0, outreachEmail_js_1.esc)(addr)}${l.postalCode ? " " + (0, outreachEmail_js_1.esc)(l.postalCode) : ""}</p>
  <div class="chips">
    ${chip(l.beds, "Beds")}${chip(l.baths, "Baths")}
    ${l.livingArea ? `<span class="chip">${Math.round(l.livingArea).toLocaleString()} sqft</span>` : ""}
    ${chip(l.yearBuilt, "Built")}${chip(prop.stories, "Storeys")}
    ${String(prop.pool || "").toUpperCase() === "Y" ? `<span class="chip">Pool</span>` : ""}
    ${chip(l.subdivision, "Subdivision")}${chip(school.district, "Schools")}
    ${chip(l.status, "Status")}${l.mlsNumber ? `<span class="chip">MLS ${(0, outreachEmail_js_1.esc)(l.mlsNumber)}</span>` : ""}
  </div>
  ${l.publicRemarks ? `<div class="rmk">${(0, outreachEmail_js_1.esc)(l.publicRemarks)}</div>` : ""}
  <a class="cta" href="mailto:?subject=${encodeURIComponent("About " + addr)}">Ask Marco about this home</a>
  ${gallery ? `<div class="homes" style="margin-top:18px">${gallery}</div>` : ""}
  <div class="note">Listing data from the San Antonio Board of REALTORS, last refreshed ${(0, outreachEmail_js_1.esc)((l.modificationTs || l.syncedAt || "").slice(0, 10))}. ${l.listOffice ? "Listed by " + (0, outreachEmail_js_1.esc)(l.listOffice) + "." : ""} Marco Puga is not necessarily the listing agent.</div>
</div></div></body></html>`;
}
function renderPublicReport(report, built) {
    const r = built;
    const active = r.byStatus.find((s) => /active/i.test(s.status))?.count ?? 0;
    const pending = r.byStatus.find((s) => /pending/i.test(s.status))?.count ?? 0;
    const tile = (l, v, s) => `<div class="tile"><div class="l">${(0, outreachEmail_js_1.esc)(l)}</div><div class="v">${(0, outreachEmail_js_1.esc)(v)}</div><div class="s">${(0, outreachEmail_js_1.esc)(s)}</div></div>`;
    const homes = r.comps.slice(0, 9).map((l) => `
    <a class="home" href="/l/${encodeURIComponent(l.listingKey)}" style="text-decoration:none;color:inherit">
      ${l.photoUrl ? `<img src="${(0, outreachEmail_js_1.esc)(l.photoUrl)}" alt="" loading="lazy">` : ""}
      <div class="b">
        <div class="p">${(0, outreachEmail_js_1.esc)(money(l.listPrice))}</div>
        <div class="a">${(0, outreachEmail_js_1.esc)([l.street, l.city].filter(Boolean).join(", "))}</div>
        <div class="s">${(0, outreachEmail_js_1.esc)([
        l.beds != null ? `${l.beds} bd` : "",
        l.baths != null ? `${l.baths} ba` : "",
        l.livingArea ? `${Math.round(l.livingArea).toLocaleString()} sqft` : "",
    ].filter(Boolean).join(" · "))}</div>
      </div></a>`).join("");
    const valueCard = report.includeHomeValue && r.displayValue != null
        ? `<div class="card"><div class="value">
          <div class="l" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#047857;font-weight:800">Estimated value</div>
          <div class="big">${(0, outreachEmail_js_1.esc)(money(r.displayValue))}</div>
          ${r.value.low != null && r.value.high != null && !r.adjusted
            ? `<div class="rng">Range ${(0, outreachEmail_js_1.esc)(money(r.value.low))} – ${(0, outreachEmail_js_1.esc)(money(r.value.high))}</div>` : ""}
          <div class="basis">${(0, outreachEmail_js_1.esc)(r.adjusted
            ? "Adjusted by Marco using local knowledge of this home and street."
            : r.value.basis)}</div>
        </div></div>`
        : report.includeHomeValue
            ? `<div class="card"><p class="sub">${(0, outreachEmail_js_1.esc)(r.value.basis)}</p></div>`
            : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Market report — ${(0, outreachEmail_js_1.esc)(report.address)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<div class="brand">Marco Puga · Real Estate</div>
<div class="card">
  <h1>${(0, outreachEmail_js_1.esc)(report.address)}</h1>
  <p class="sub">${(0, outreachEmail_js_1.esc)(r.area.label)} · ${r.stats.count} listing${r.stats.count === 1 ? "" : "s"} in this snapshot · updated ${(0, outreachEmail_js_1.esc)(r.builtAt.slice(0, 10))}</p>
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
  <div class="note" style="margin:0;padding:0;border:0">${(0, outreachEmail_js_1.esc)(r.notes.join(" "))}
  Figures are asking prices on live listings from the San Antonio Board of REALTORS, not an appraisal.
  Want a proper valuation on this home? Reply to Marco's email any time.</div>
</div>
</div></body></html>`;
}
