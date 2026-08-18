"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPlannerTeam = listPlannerTeam;
exports.plannerMember = plannerMember;
exports.plannerMemberName = plannerMemberName;
/**
 * Who can be assigned a piece of content.
 *
 * The CRM has two overlapping people lists and the planner needs both:
 *
 *   teamRoster  — the four operators who log in and run the Task Command
 *                 board (Marco, Wesley, Kendrick, Carlos). They carry the
 *                 accent colours the rest of the app already uses for them.
 *   users.ts    — the CRM user table proper, which is where an account is
 *                 deactivated when someone is offboarded.
 *
 * Assigning from only one of them would either lose the accent colours or lose
 * the active/inactive state, so this merges them by name and prefers the
 * roster's colour. An offboarded person is NOT dropped: their name still has
 * to render on the content they were assigned, marked inactive, or the card
 * silently loses its owner.
 */
const teamRoster_js_1 = require("./teamRoster.js");
const users_js_1 = require("./users.js");
function initials(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length)
        return "?";
    if (parts.length === 1)
        return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
const norm = (s) => String(s || "").toLowerCase().trim();
function listPlannerTeam() {
    const out = [];
    const byName = new Map();
    for (const m of (0, teamRoster_js_1.listTeamMembers)()) {
        const entry = {
            userId: m.id,
            fullName: m.name,
            role: m.role,
            accentColor: m.color,
            avatarInitials: initials(m.name),
            avatarUrl: null,
            active: true,
            source: "roster",
        };
        out.push(entry);
        byName.set(norm(m.name), entry);
    }
    let crmUsers = [];
    try {
        crmUsers = (0, users_js_1.getUsers)();
    }
    catch {
        crmUsers = [];
    }
    for (const u of crmUsers) {
        const key = norm(u.name);
        const existing = byName.get(key);
        if (existing) {
            // Same person, two records. The CRM row is what knows they were
            // offboarded, so its active flag wins over the roster's assumption.
            if (u.active === false)
                existing.active = false;
            continue;
        }
        out.push({
            userId: u.id,
            fullName: u.name,
            role: u.role,
            accentColor: u.avatarColor || "#2dd4ee",
            avatarInitials: u.avatarInitials || initials(u.name),
            avatarUrl: null,
            active: u.active !== false,
            source: "crm",
        });
    }
    return out;
}
function plannerMember(userId) {
    const key = norm(userId);
    return listPlannerTeam().find((m) => norm(m.userId) === key) || null;
}
/** Display name for an id, with "(Inactive)" appended when they are offboarded. */
function plannerMemberName(userId) {
    const m = plannerMember(userId);
    if (!m)
        return userId;
    return m.active ? m.fullName : `${m.fullName} (Inactive)`;
}
