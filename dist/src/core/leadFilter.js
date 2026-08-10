"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyLeadFilter = applyLeadFilter;
exports.filterDashboardLeads = filterDashboardLeads;
const db_js_1 = require("./db.js");
const db_js_2 = require("./db.js");
function parseRangeBound(iso, endOfDay) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return null;
    if (endOfDay)
        d.setHours(23, 59, 59, 999);
    else
        d.setHours(0, 0, 0, 0);
    return d.getTime();
}
function inDateRange(ts, from, to) {
    if (!from && !to)
        return true;
    if (!ts)
        return false;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t))
        return false;
    if (from) {
        const f = parseRangeBound(from, false);
        if (f !== null && t < f)
            return false;
    }
    if (to) {
        const e = parseRangeBound(to, true);
        if (e !== null && t > e)
            return false;
    }
    return true;
}
function normalizeFilterSource(label) {
    return label.trim().toLowerCase();
}
/** 1-12 from a YYYY-MM-DD string, or 0 when absent/garbled. */
function monthOf(day) {
    if (!day)
        return 0;
    const m = /^\d{4}-(\d{2})-\d{2}$/.exec(day);
    return m ? Number(m[1]) : 0;
}
function leadMatchesSource(row, sources) {
    const plat = String(row.platform || "").toLowerCase();
    const src = String(row.source || "").toLowerCase();
    return sources.some((raw) => {
        const s = normalizeFilterSource(raw);
        if (s === "instagram" || s === "ig")
            return plat.includes("insta") || src.includes("insta");
        if (s === "tiktok" || s === "tik")
            return plat.includes("tik") || src.includes("tik");
        if (s === "manual")
            return plat === "manual" || src === "manual";
        return src.includes(s) || plat.includes(s);
    });
}
/** Apply LeadFilter with AND logic across fields. */
function applyLeadFilter(rows, filter) {
    return rows.filter((row) => {
        if (filter.intent) {
            const intent = (0, db_js_1.normalizeCrmIntent)(row.crmIntent);
            if (intent !== filter.intent)
                return false;
        }
        if (filter.status?.length) {
            const st = (0, db_js_1.normalizeCrmStatus)(row.crmStatus);
            if (!filter.status.some((s) => (0, db_js_1.normalizeCrmStatus)(s) === st))
                return false;
        }
        if (filter.source?.length && !leadMatchesSource(row, filter.source))
            return false;
        if (filter.stage?.length) {
            const stage = row.crmStage || "new";
            if (!filter.stage.includes(stage))
                return false;
        }
        if (filter.tags?.length) {
            const tags = row.tags || [];
            if (!filter.tags.some((t) => tags.includes(t)))
                return false;
        }
        if (filter.tagsExclude?.length) {
            const tags = row.tags || [];
            if (filter.tagsExclude.some((t) => tags.includes(t)))
                return false;
        }
        if (!inDateRange(row.createdAt, filter.dateAddedFrom, filter.dateAddedTo))
            return false;
        if (!inDateRange(row.lastActivity, filter.lastContactFrom, filter.lastContactTo))
            return false;
        if (filter.assignedUser) {
            const uid = filter.assignedUser.trim();
            if (uid && uid !== "all" && (row.assignedUserId || "") !== uid)
                return false;
        }
        if (filter.hasEmail !== undefined && Boolean(row.email && String(row.email).trim()) !== filter.hasEmail)
            return false;
        if (filter.hasPhone !== undefined && Boolean(row.phone && String(row.phone).trim()) !== filter.hasPhone)
            return false;
        if (filter.hasAddress !== undefined && Boolean(row.address && String(row.address).trim()) !== filter.hasAddress)
            return false;
        if (filter.autoPlan) {
            const enrollments = row.autoPlanEnrollments || [];
            if (filter.autoPlan === "any") {
                if (!enrollments.length)
                    return false;
            }
            else if (filter.autoPlan === "none") {
                if (enrollments.length)
                    return false;
            }
            else if (!enrollments.some((e) => String(e.planName || e.planId || "") === filter.autoPlan))
                return false;
        }
        if (filter.birthdayMonth && monthOf(row.birthday) !== filter.birthdayMonth)
            return false;
        if (filter.anniversaryMonth && monthOf(row.homeAnniversary) !== filter.anniversaryMonth)
            return false;
        return true;
    });
}
async function filterDashboardLeads(filter) {
    const snap = await (0, db_js_2.getDashboardSnapshot)();
    return applyLeadFilter(snap.leads, filter);
}
