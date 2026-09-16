#!/usr/bin/env node
/**
 * Static checks for the CRM Command Center "doable now" pass.
 *
 * Asserts honesty constraints in public/crm-brivity.html and the website
 * webhook wiring — no fabricated OPPS/TX seed, no nodata smart filters in the
 * UI, People merge, Follow-Up rail, market helpers, source min-count, etc.
 *
 * Usage: node scripts/verify-crm-command-center.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const html = readFileSync(join(root, "public/crm-brivity.html"), "utf8");
const lockdown = readFileSync(join(root, "src/core/lockdown.ts"), "utf8");
const websiteWh = readFileSync(join(root, "src/core/websiteWebhook.ts"), "utf8");
const server = readFileSync(join(root, "src/server.ts"), "utf8");
const perception = readFileSync(join(root, "src/harvey/perception.ts"), "utf8");

let pass = 0;
const fail = [];
const ok = (n, c, d) => {
  if (c) {
    pass++;
    console.log("  ok " + n);
  } else {
    fail.push(n + (d ? " — " + d : ""));
    console.error("FAIL " + n + (d ? " — " + d : ""));
  }
};

console.log("CRM Command Center — static checks\n");

// 1. Opps rail / fabricated list gone
ok("no Opportunities rail button", !/data-view="opps"/.test(html));
ok("no view-opps section", !/id="view-opps"/.test(html));
ok("no OPPS seed loop", !/OPPS\.push\(/.test(html) && !/for\(let i=0;i<16;i\+\+\)[\s\S]{0,80}OPPS/.test(html));
ok("opportunity types are tags", /OPP_TYPE_TAGS\s*=\s*\[/.test(html) && /"FSBO"/.test(html) && /"Pre-Foreclosure"/.test(html));
ok("profile can add opportunity type", /ldOppTagBtn/.test(html) && /Opportunity type/.test(html));

// 2. Follow-Up
ok("Follow-Up rail button exists", /data-view="followup"/.test(html));
ok("Follow-Up view + renderer", /id="view-followup"/.test(html) && /function renderFollowUp\(/.test(html));
ok("Follow-Up matches Due Today or urgent", /due\.label==="Due Today"/.test(html) && /crmCallQueue==="urgent"/.test(html));

// 3. People merge
ok("no visible separate Leads rail button", !/<button class="r" data-view="leads"[^>]*title="Leads"><svg/.test(html));
ok("People rail remains", /data-view="people"/.test(html));
ok("hidden leads compatibility hook kept for deep-links", /data-view="leads"/.test(html) && /display:none/.test(html));
ok("people subtabs include Leads", /data-psec="leads"/.test(html) && /data-psec="all"/.test(html));
ok("openPeopleSection wires Leads default", /function openPeopleSection\(/.test(html) && /peopleSection==="leads"/.test(html));

// 4. Market badge
ok("leadMarket helper exists", /function leadMarket\(/.test(html));
ok("FL detection includes mojo fl", /mojo\s\*fl/.test(html) || /mojo\\s\*fl/.test(html));
ok("marketPill used on profile name", /marketPill\(l\)/.test(html));
ok("TX market filter on transactions", /data-txm="TX"/.test(html) && /data-txm="FL"/.test(html));
ok("Finance market filter present", /data-finm="TX"/.test(html) && /finMarketFilter/.test(html));

// 5. Sources >= 5
ok("sources default to count >= 5", /SRC_MIN_COUNT\s*=\s*5/.test(html));
ok("show-all expander for under-5 sources", /under 5/.test(html) || /Show all/.test(html));

// 6. Smart filters — nodata removed, keepers kept, create button
ok("visit30 filter removed from UI", !/data-sf="visit30"/.test(html));
ok("visit_week removed", !/data-sf="visit_week"/.test(html));
ok("visit_today removed", !/data-sf="visit_today"/.test(html));
ok("overdue smart filter removed from UI", !/data-sf="overdue"/.test(html));
ok("SMART_NODATA deleted", !/SMART_NODATA\s*=/.test(html));
for (const k of ["buyers_email", "hot", "no_plan", "partial", "watch_nurture", "mr_no_task", "no_mr", "past_clients"]) {
  ok("keeper smart filter " + k, new RegExp('data-sf="' + k + '"').test(html) || new RegExp(k + ":").test(html));
}
ok("Create Smart Filter button", /sfCreateBtn/.test(html) && /Create Smart Filter/.test(html));
ok("custom filters use localStorage", /marcoCrmCustomSmartFilters/.test(html));

// 7. No fabricated TX
ok("TX_DIST seed removed", !/TX_DIST/.test(html));
ok("no for-loop over TX_DIST", !/for\(let i=0;i<TX_DIST\.length/.test(html));
ok("TX starts empty", /let TX\s*=\s*\[\s*\]/.test(html) || /let TX=\[\]/.test(html));
ok("empty TX state is honest", /No transactions imported yet/.test(html));

// 8. Documents grouping
ok("documents group by transaction folder", /doc-fold/.test(html) && /function documentsBodyHTML/.test(html));
ok("General folder for ungrouped docs", /ensure\("general","General"\)/.test(html) || /"General"/.test(html));

// 9. Website webhook
ok("websiteWebhook module refuses when secret unset", /websiteSecretConfigured/.test(websiteWh));
ok("website secret compared via timingSafeEqual", /timingSafeEqual/.test(websiteWh));
ok("website source is Website", /source:\s*"Website"/.test(websiteWh));
ok("server mounts POST /api/website/lead", /app\.post\(\s*"\/api\/website\/lead"/.test(server));
ok("lockdown allowlists /api/website/lead", /"\/api\/website\/lead"/.test(lockdown));

// 10. Harvey speed win
ok("Harvey caps conversation summaries", /MAX_CONV_SUMMARIES/.test(perception));
ok("Harvey has lite summarize path", /summarizeLeadLite/.test(perception));

console.log("\n" + pass + " passed, " + fail.length + " failed");
if (fail.length) {
  console.error(fail.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
