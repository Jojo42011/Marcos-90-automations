/**
 * Assertions for the Transactions UX slice (Aug 2026): add-flow, sort, filter,
 * columns, detail view, extended store fields. Run AFTER `npm run build`:
 *   node scripts/verify-tx-ux.mjs
 */
import { readFileSync } from "fs";
import assert from "assert";

let passed = 0; const failures = [];
function check(name, fn) { try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); } }
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const store = read("src/core/transactionsStore.ts");
const srv = read("src/server.ts");
const html = read("public/crm-brivity.html");

/* ── Store: Brivity types/statuses/dates are real columns ────────────────── */
check("store: deal types cover Brivity's Select Transaction Type flow", () => {
  for (const t of ["tenant", "landlord", "referral"]) assert(store.includes(`"${t}"`), `missing ${t}`);
});
check("store: lifecycle statuses extended without touching the deadline-engine states", () => {
  for (const st of ["pipeline", "coming_soon", "expired", "withdrawn", "archived"]) {
    assert(new RegExp(`\\| "${st}"`).test(store), `missing status ${st}`);
  }
  assert(/under_contract"[\s\S]{0,300}deadline engine/.test(store),
    "the comment must say under_contract still drives deadlines");
});
check("store: the six Brivity date columns exist, mapped, and bound in INSERT+UPDATE", () => {
  for (const c of ["date_listed", "date_canceled", "status_changed_at", "deposit_due", "additional_deposit_due", "escrow_signing_date"]) {
    assert(store.includes(`["${c}", "TEXT"]`), `migration missing ${c}`);
    assert(store.includes(`${c} = ?`) || store.includes(`${c},`), `UPDATE/INSERT missing ${c}`);
  }
  for (const f of ["dateListed", "dateCanceled", "statusChangedAt", "depositDue", "additionalDepositDue", "escrowSigningDate"]) {
    assert(new RegExp(`${f}\\?: string`).test(store), `interface missing ${f}`);
  }
});
check("store: statusChangedAt stamps automatically when status actually moves", () => {
  assert(/updates\.status !== undefined && updates\.status !== existing\.status/.test(store));
});

/* ── Server: parse/POST honor the new surface, invalid values rejected ───── */
check("server: dealType/status validated against explicit sets (junk cannot land)", () => {
  assert(/TX_DEAL_TYPES\.has\(body\.dealType\)/.test(srv));
  assert(/TX_STATUSES\.has\(body\.status\)/.test(srv));
});
check("server: new date fields follow the expiration contract — ISO sets, null clears", () => {
  assert(/\["dateListed", "dateCanceled", "depositDue", "additionalDepositDue", "escrowSigningDate"\]/.test(srv));
});
check("server: POST passes the full field set into createTransaction", () => {
  const post = srv.split('app.post("/api/transactions"')[1]?.slice(0, 1600) ?? "";
  for (const f of ["listPrice", "source", "expiration", "dateListed", "agent"]) {
    assert(new RegExp(`${f}: parsed\\.${f}`).test(post), `POST drops ${f}`);
  }
});

/* ── CRM: the four toolbar features are wired, not decorative ────────────── */
check("crm: add-flow is Brivity's two-step (type picker → info modal) and POSTs", () => {
  assert(/Select Transaction Type/.test(html));
  assert(/txTypePick/.test(html) && /"tenant"/.test(html) && /"landlord"/.test(html) && /"referral"/.test(html));
  assert(/Add Transaction Information/.test(html));
  const add = html.split("function openInfo")[1]?.slice(0, 3000) ?? "";
  assert(/fetch\(crmApi\("\/api\/transactions"\),\{method:"POST"/.test(add), "create must hit the real API");
});
check("crm: sort covers the PDF's field list and drives the render", () => {
  for (const f of ["closeDate", "closePrice", "dateCanceled", "dateListed", "expiration", "gci", "lastUpdated", "listPrice", "statusChangedAt"]) {
    assert(new RegExp(`\\["${f}"`).test(html), `sort field ${f} missing`);
  }
  assert(/txApplySortFilter\(list\)/.test(html), "renderTx must route through the new sort/filter");
});
check("crm: filter modal has agent/type/status/source + the three date ranges", () => {
  const f = html.split('document.getElementById("txFilterBtn").onclick')[1]?.slice(0, 4000) ?? "";
  for (const id of ["fAgent", "fType", "fSource", "fMa", "fCd", "fSc"]) assert(f.includes(id), `filter control ${id} missing`);
});
check("crm: columns picker persists per browser and hides via CSS, not data loss", () => {
  assert(/localStorage\.setItem\("txViewPrefs"/.test(html));
  assert(/nth-child/.test(html.split("function applyCols")[1]?.slice(0, 400) ?? ""), "hiding must be display:none, not column removal");
});
check("crm: detail view opens from the row, edits dates via PATCH, applies transaction plans", () => {
  assert(/openTxDetail/.test(html));
  const det = html.split("function paintDetail")[1]?.slice(0, 6000) ?? "";
  assert(/data-dfield/.test(det) && /method:"PATCH"/.test(det));
  assert(/auto-plans\//.test(det), "the APPLY AUTO PLAN button must hit the enroll route");
  assert(/planType==="transaction"/.test(html.split("openTxDetail")[1]?.slice(0, 800) ?? ""),
    "only transaction plans may be offered on a deal");
});
check("crm: the API status map knows the new lifecycle states (coming_soon showed as active)", () => {
  const map = html.split("TX_STATUS_FROM_API={")[1]?.slice(0, 400) ?? "";
  for (const st of ["pipeline", "coming_soon", "expired", "withdrawn", "archived"]) {
    assert(map.includes(st), `status map missing ${st} — it would display and filter as "active"`);
  }
});
check("crm: demo-only rows say so instead of opening an empty detail", () => {
  assert(/demo dataset/.test(html.split("openTxDetail")[1]?.slice(0, 600) ?? ""));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.error("  ✗ " + f); process.exit(1); }
