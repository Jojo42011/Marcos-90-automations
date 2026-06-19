/**
 * Brivity migration Phase 2 — gap-fill matched leads + create all NO_MATCH rows.
 * Writes db.json directly (no createLead side effects: no SMS, routing, or email triggers).
 *
 * Usage:
 *   node scripts/brivity-migration-apply.mjs --csv brivity-migration-scratch/brivity-export-from-api.csv --db brivity-migration-scratch/db.json
 *   Add --dry-run to preview counts without writing.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs() {
  const args = process.argv.slice(2);
  let csv = resolve(ROOT, "brivity-migration-scratch/brivity-export-from-api.csv");
  let db = resolve(ROOT, "brivity-migration-scratch/db.json");
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--csv" && args[i + 1]) csv = resolve(args[++i]);
    else if (args[i] === "--db" && args[i + 1]) db = resolve(args[++i]);
    else if (args[i] === "--dry-run") dryRun = true;
  }
  return { csv, db, dryRun };
}

const HEADER_ALIASES = {
  firstName: ["First Name", "first_name"],
  lastName: ["Last Name", "last_name"],
  name: ["Name", "Full Name"],
  phone: ["Phone", "phone", "Phone Number", "Mobile", "Cell"],
  email: ["Email", "email", "E-mail"],
  source: ["Source", "Lead Source", "source"],
  brivityId: ["Contact ID", "ID", "Contact Id", "person_id"],
  crmStatus: ["Status", "Lead Status", "status"],
  crmStage: ["Stage", "Pipeline Stage", "stage"],
  crmIntent: ["Type", "Lead Type", "lead_type"],
  crmNotes: ["Notes", "Description", "note"],
  propertyInquired: ["Street Address", "Property Address", "Address"],
  "criteria.area": ["City", "Area"],
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && next === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim()));
  const headers = nonEmpty[0].map((h) => h.trim());
  const dataRows = nonEmpty.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows: dataRows };
}

function resolveColumnMap(headers) {
  const map = {};
  const used = new Set();
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    const matches = headers.filter((h) => aliases.some((a) => a.toLowerCase() === h.toLowerCase()));
    if (matches.length === 1) {
      map[field] = matches[0];
      used.add(matches[0]);
    }
  }
  if (headers.includes("Tags")) map.tags = "Tags";
  if (headers.includes("State")) map.state = "State";
  return map;
}

function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 11) {
    const tail = digits.slice(-10);
    if (tail.length === 10) return tail;
  }
  return null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const e = String(raw).trim().toLowerCase();
  return e.includes("@") ? e : null;
}

function isEmptyValue(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && !v.trim()) return true;
  if (Array.isArray(v) && !v.length) return true;
  return false;
}

function getCsvValue(row, col) {
  return col ? (row[col] ?? "").trim() : "";
}

function buildNameFromRow(row, colMap) {
  const first = getCsvValue(row, colMap.firstName);
  const last = getCsvValue(row, colMap.lastName);
  const combined = [first, last].filter(Boolean).join(" ").trim();
  return combined || null;
}

function mapBrivityStatus(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return "new";
  const table = {
    new: "new",
    hot: "hot",
    nurture: "nurture",
    watch: "watch",
    archived: "dead",
    unqualified: "dead",
    dead: "dead",
    unresponsive: "unresponsive",
  };
  return table[s] || "new";
}

function mapBrivityStage(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return "new";
  const table = {
    new: "new",
    "new lead": "new",
    hot: "hot",
    warm: "warm",
    cold: "cold",
    nurture: "cold",
    "attempted contact": "cold",
    pending: "pending",
    appointment_set: "appointment_set",
    showing_set: "showing_set",
    under_contract: "under_contract",
    closed: "closed",
  };
  const norm = s.replace(/\s+/g, " ");
  if (table[norm]) return table[norm];
  const underscored = s.replace(/\s+/g, "_");
  const allowed = new Set([
    "new",
    "hot",
    "warm",
    "cold",
    "pending",
    "appointment_set",
    "showing_set",
    "under_contract",
    "closed",
  ]);
  return allowed.has(underscored) ? underscored : "new";
}

function mapBrivityIntent(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  if (!s) return "buyer";
  if (s.includes("buy") && s.includes("sell")) return "buyer_seller";
  if (s.includes("sell")) return "seller";
  if (s.includes("buy")) return "buyer";
  return "buyer";
}

function parseTags(row, colMap) {
  const raw = getCsvValue(row, colMap.tags);
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractUsernameFromNotes(notes) {
  const m = String(notes || "").match(/username:\s*@?([\w.]+)/i);
  return m ? m[1] : null;
}

function platformFromSource(source) {
  const s = String(source || "").toLowerCase();
  if (s.includes("tiktok")) return "tiktok";
  if (s.includes("instagram")) return "instagram";
  if (s.includes("mojo")) return "mojo";
  if (s.includes("idx")) return "brivity_idx";
  if (s.includes("call")) return "call_in";
  return "brivity";
}

function extractProposedValues(row, colMap) {
  const out = {};
  const name = buildNameFromRow(row, colMap);
  if (name) out.name = name;
  const phone = normalizePhone(getCsvValue(row, colMap.phone));
  if (phone) out.phone = phone;
  const email = normalizeEmail(getCsvValue(row, colMap.email));
  if (email) out.email = email;
  const source = getCsvValue(row, colMap.source);
  if (source) out.source = source;
  const brivityId = getCsvValue(row, colMap.brivityId);
  if (brivityId) out.brivityId = brivityId;
  out.crmStatus = mapBrivityStatus(getCsvValue(row, colMap.crmStatus));
  out.crmStage = mapBrivityStage(getCsvValue(row, colMap.crmStage));
  out.crmIntent = mapBrivityIntent(getCsvValue(row, colMap.crmIntent));
  const notes = getCsvValue(row, colMap.crmNotes);
  if (notes) out.crmNotes = notes;
  const property = getCsvValue(row, colMap.propertyInquired);
  if (property) out.propertyInquired = property;
  const area = getCsvValue(row, colMap["criteria.area"]);
  const state = getCsvValue(row, colMap.state);
  if (area || state) {
    out.criteria = {};
    if (area) out.criteria.area = area;
    if (state) out.criteria.timeline = state;
  }
  const tags = parseTags(row, colMap);
  if (tags.length) out.tags = tags;
  return out;
}

function computeGapFills(lead, proposed) {
  const fills = {};
  for (const [key, csvValue] of Object.entries(proposed)) {
    if (key === "criteria" && csvValue && typeof csvValue === "object") {
      const existing = lead.criteria || null;
      const partial = {};
      for (const [ck, cv] of Object.entries(csvValue)) {
        if (isEmptyValue(cv)) continue;
        if (isEmptyValue(existing?.[ck])) partial[ck] = cv;
      }
      if (Object.keys(partial).length) fills.criteria = { ...(existing || {}), ...partial };
      continue;
    }
    if (key === "tags" && Array.isArray(csvValue)) {
      const existing = Array.isArray(lead.tags) ? lead.tags : [];
      if (!existing.length) fills.tags = csvValue;
      continue;
    }
    if (isEmptyValue(csvValue)) continue;
    if (isEmptyValue(lead[key])) fills[key] = csvValue;
  }
  return fills;
}

function buildIndexes(leadsById) {
  const byPhone = new Map();
  const byEmail = new Map();
  const byBrivityId = new Set();
  for (const [id, lead] of Object.entries(leadsById)) {
    const p = normalizePhone(lead.phone);
    if (p) {
      const arr = byPhone.get(p) || [];
      arr.push(id);
      byPhone.set(p, arr);
    }
    const e = normalizeEmail(lead.email);
    if (e) {
      const arr = byEmail.get(e) || [];
      arr.push(id);
      byEmail.set(e, arr);
    }
    if (lead.brivityId) byBrivityId.add(String(lead.brivityId));
  }
  return { byPhone, byEmail, byBrivityId };
}

function matchRow(raw, colMap, indexes) {
  const phone = normalizePhone(getCsvValue(raw, colMap.phone));
  const email = normalizeEmail(getCsvValue(raw, colMap.email));
  if (phone) {
    const ids = indexes.byPhone.get(phone) || [];
    if (ids.length === 1) return { bucket: "MATCHED", leadIds: ids, matchKey: "phone" };
    if (ids.length > 1) return { bucket: "MATCHED_AMBIGUOUS", leadIds: ids, matchKey: "phone" };
  }
  if (email) {
    const ids = indexes.byEmail.get(email) || [];
    if (ids.length === 1) return { bucket: "MATCHED", leadIds: ids, matchKey: "email" };
    if (ids.length > 1) return { bucket: "MATCHED_AMBIGUOUS", leadIds: ids, matchKey: "email" };
  }
  return { bucket: "NO_MATCH", leadIds: [] };
}

function leadKey(platform, userId) {
  return `${platform}:${userId}`;
}

function buildNewLead(proposed, rowIndex, idCounter, now) {
  const brivityId = proposed.brivityId ? String(proposed.brivityId) : `row-${rowIndex}`;
  const source = proposed.source || "Brivity";
  const platform = platformFromSource(source);
  const userId = `brivity-${brivityId}`;
  const notes = proposed.crmNotes || null;
  const username = extractUsernameFromNotes(notes);
  const phone = proposed.phone || null;
  return {
    id: String(idCounter),
    platform,
    userId,
    username,
    name: proposed.name || null,
    phone,
    email: proposed.email || null,
    state: phone ? "phone_captured" : "new",
    source,
    adCampaign: null,
    propertyInquired: proposed.propertyInquired || null,
    criteria: proposed.criteria || null,
    brivityId: proposed.brivityId ? String(proposed.brivityId) : null,
    crmStatus: proposed.crmStatus || "new",
    crmStage: proposed.crmStage || "new",
    crmPriority: "normal",
    crmIntent: proposed.crmIntent || "buyer",
    crmCallQueue: "none",
    crmNotes: notes,
    tags: proposed.tags || [],
    alerts: 0,
    reports: 0,
    lastActivity: null,
    assignedUserId: null,
    assignedUserName: null,
    phoneCapturedAt: phone ? now : undefined,
    phoneNumberSeen: phone ? false : undefined,
    sourceRoutingCompletedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function applyGapFill(lead, fills, now) {
  const next = { ...lead, ...fills, updatedAt: now };
  if (fills.criteria) next.criteria = fills.criteria;
  return next;
}

function main() {
  const { csv, db, dryRun } = parseArgs();
  if (!existsSync(csv)) {
    console.error(`CSV not found: ${csv}`);
    process.exit(1);
  }
  if (!existsSync(db)) {
    console.error(`db.json not found: ${db}`);
    process.exit(1);
  }

  const csvText = readFileSync(csv, "utf8").replace(/^\uFEFF/, "");
  const { headers, rows } = parseCsv(csvText);
  const colMap = resolveColumnMap(headers);

  const dbData = JSON.parse(readFileSync(db, "utf8"));
  const leadsById = dbData.leadsById || {};
  const leadKeyToId = dbData.leadKeyToId || {};
  const conversationsByLeadId = dbData.conversationsByLeadId || {};
  let idCounter = Number(dbData.idCounter) || 1;

  const indexes = buildIndexes(leadsById);
  const now = new Date().toISOString();
  const log = {
    appliedAt: now,
    dryRun,
    csv,
    db,
    gapFilled: 0,
    created: 0,
    skippedAmbiguous: 0,
    skippedDuplicateBrivityId: 0,
    fieldFillCounts: {},
  };

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const rowIndex = i + 1;
    const proposed = extractProposedValues(raw, colMap);
    const { bucket, leadIds } = matchRow(raw, colMap, indexes);

    if (bucket === "MATCHED") {
      const leadId = leadIds[0];
      const lead = leadsById[leadId];
      if (!lead) continue;
      const fills = computeGapFills(lead, proposed);
      if (!Object.keys(fills).length) continue;
      if (!dryRun) {
        leadsById[leadId] = applyGapFill(lead, fills, now);
        const p = normalizePhone(leadsById[leadId].phone);
        const e = normalizeEmail(leadsById[leadId].email);
        if (p) indexes.byPhone.set(p, [leadId]);
        if (e) indexes.byEmail.set(e, [leadId]);
        if (leadsById[leadId].brivityId) indexes.byBrivityId.add(String(leadsById[leadId].brivityId));
      }
      log.gapFilled++;
      for (const k of Object.keys(fills)) log.fieldFillCounts[k] = (log.fieldFillCounts[k] || 0) + 1;
      continue;
    }

    if (bucket === "MATCHED_AMBIGUOUS") {
      log.skippedAmbiguous++;
      continue;
    }

    const bid = proposed.brivityId ? String(proposed.brivityId) : null;
    if (bid && indexes.byBrivityId.has(bid)) {
      log.skippedDuplicateBrivityId++;
      continue;
    }

    const newLead = buildNewLead(proposed, rowIndex, idCounter, now);
    const key = leadKey(newLead.platform, newLead.userId);
    if (leadKeyToId[key] && leadsById[leadKeyToId[key]]) {
      log.skippedDuplicateBrivityId++;
      continue;
    }

    if (!dryRun) {
      leadsById[newLead.id] = newLead;
      leadKeyToId[key] = newLead.id;
      conversationsByLeadId[newLead.id] = conversationsByLeadId[newLead.id] || { messages: [] };
      idCounter++;
      if (newLead.phone) {
        const p = normalizePhone(newLead.phone);
        if (p) indexes.byPhone.set(p, [newLead.id]);
      }
      if (newLead.email) {
        const e = normalizeEmail(newLead.email);
        if (e) indexes.byEmail.set(e, [newLead.id]);
      }
      if (newLead.brivityId) indexes.byBrivityId.add(String(newLead.brivityId));
    } else {
      idCounter++;
    }
    log.created++;
  }

  const outPath = resolve(ROOT, "brivity-migration-scratch/brivity-migration-apply-log.json");
  mkdirSync(resolve(ROOT, "brivity-migration-scratch"), { recursive: true });

  if (!dryRun) {
    const backup = `${db}.backup-${Date.now()}`;
    copyFileSync(db, backup);
    dbData.leadsById = leadsById;
    dbData.leadKeyToId = leadKeyToId;
    dbData.conversationsByLeadId = conversationsByLeadId;
    dbData.idCounter = idCounter;
    writeFileSync(db, JSON.stringify(dbData, null, 2), "utf8");
    log.backup = backup;
    log.totalLeadsAfter = Object.keys(leadsById).length;
  }

  writeFileSync(outPath, JSON.stringify(log, null, 2), "utf8");

  console.log("\n=== BRIVITY MIGRATION APPLY ===\n");
  console.log(dryRun ? "(DRY RUN — no db.json write)" : `(WRITTEN → ${db})`);
  console.log(`Gap-filled existing leads: ${log.gapFilled}`);
  console.log(`New leads created:       ${log.created}`);
  console.log(`Skipped (ambiguous):     ${log.skippedAmbiguous}`);
  console.log(`Skipped (duplicate):     ${log.skippedDuplicateBrivityId}`);
  if (log.totalLeadsAfter) console.log(`Total leads in db:       ${log.totalLeadsAfter}`);
  console.log("\nGap-fill field counts:");
  for (const [k, n] of Object.entries(log.fieldFillCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${n}`);
  }
  if (log.backup) console.log(`\nBackup: ${log.backup}`);
  console.log(`Log: ${outPath}`);
}

main();
