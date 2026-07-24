"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUsers = getUsers;
exports.saveUsers = saveUsers;
exports.getUserById = getUserById;
exports.getUserByEmail = getUserByEmail;
exports.createUser = createUser;
exports.updateUser = updateUser;
exports.deleteUser = deleteUser;
const fs_1 = require("fs");
const path_1 = require("path");
const types_js_1 = require("./types.js");
function resolveUsersPath() {
    const explicit = process.env.USERS_JSON_PATH?.trim();
    if (explicit)
        return explicit;
    const flyDb = "/data/db.json";
    const localDb = (0, path_1.join)(process.cwd(), "data", "local-dashboard-db.json");
    const dbPath = process.env.DB_JSON_PATH?.trim() || ((0, fs_1.existsSync)(flyDb) ? flyDb : localDb);
    return (0, path_1.join)((0, path_1.dirname)(dbPath), "users.json");
}
const USERS_PATH = resolveUsersPath();
function nowIso() {
    return new Date().toISOString();
}
function genId() {
    return `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function avatarInitialsFromName(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length)
        return "?";
    if (parts.length === 1)
        return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function buildDefaultUsers() {
    const ts = nowIso();
    const seeds = [
        { name: "Marco Puga", email: "marco@example.com", role: "admin", color: "#0ea5e9" },
        { name: "Carlos", email: "carlos@example.com", role: "agent", color: "#10b981" },
    ];
    return seeds.map((s) => ({
        id: genId(),
        name: s.name,
        email: s.email,
        role: s.role,
        permissions: { ...types_js_1.ROLE_PERMISSIONS[s.role] },
        assignedLeadIds: s.role === "agent" ? [] : undefined,
        active: true,
        createdAt: ts,
        avatarInitials: avatarInitialsFromName(s.name),
        avatarColor: s.color,
    }));
}
function writeUsersFile(users) {
    (0, fs_1.mkdirSync)((0, path_1.dirname)(USERS_PATH), { recursive: true });
    (0, fs_1.writeFileSync)(USERS_PATH, JSON.stringify(users, null, 2), "utf8");
}
function normalizeUser(raw) {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    if (!name || !email)
        return null;
    const role = raw.role === "admin" || raw.role === "agent" || raw.role === "isa" || raw.role === "custom"
        ? raw.role
        : "agent";
    const permsRaw = raw.permissions && typeof raw.permissions === "object" ? raw.permissions : null;
    const permissions = permsRaw
        ? { ...types_js_1.ROLE_PERMISSIONS[role], ...permsRaw }
        : { ...types_js_1.ROLE_PERMISSIONS[role] };
    const assignedLeadIds = Array.isArray(raw.assignedLeadIds)
        ? raw.assignedLeadIds.filter((id) => typeof id === "string")
        : undefined;
    return {
        id: typeof raw.id === "string" && raw.id ? raw.id : genId(),
        name,
        email,
        role,
        permissions,
        assignedLeadIds,
        active: raw.active !== false,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
        lastLogin: typeof raw.lastLogin === "string" ? raw.lastLogin : undefined,
        avatarInitials: typeof raw.avatarInitials === "string" && raw.avatarInitials
            ? raw.avatarInitials
            : avatarInitialsFromName(name),
        avatarColor: typeof raw.avatarColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.avatarColor)
            ? raw.avatarColor
            : "#64748b",
        passwordHash: typeof raw.passwordHash === "string" && raw.passwordHash ? raw.passwordHash : undefined,
        mustChangePassword: raw.mustChangePassword === true,
    };
}
function getUsers() {
    try {
        if (!(0, fs_1.existsSync)(USERS_PATH)) {
            const seeded = buildDefaultUsers();
            try {
                writeUsersFile(seeded);
            }
            catch (err) {
                console.error("[users] seed write failed:", err);
            }
            return seeded;
        }
        const raw = (0, fs_1.readFileSync)(USERS_PATH, "utf8");
        if (!raw.trim())
            return [];
        const data = JSON.parse(raw);
        if (!Array.isArray(data))
            return [];
        const out = [];
        for (const item of data) {
            if (!item || typeof item !== "object")
                continue;
            const u = normalizeUser(item);
            if (u)
                out.push(u);
        }
        return out;
    }
    catch (err) {
        console.error("[users] getUsers failed:", err);
        return [];
    }
}
function saveUsers(users) {
    try {
        writeUsersFile(users);
    }
    catch (err) {
        console.error("[users] saveUsers failed:", err);
    }
}
function getUserById(id) {
    return getUsers().find((u) => u.id === id) ?? null;
}
function getUserByEmail(email) {
    const e = email.trim().toLowerCase();
    return getUsers().find((u) => u.email.trim().toLowerCase() === e) ?? null;
}
function createUser(data) {
    const users = getUsers();
    const name = data.name.trim() || "User";
    const role = data.role;
    const created = {
        id: genId(),
        name,
        email: data.email.trim(),
        role,
        permissions: data.permissions ?? { ...types_js_1.ROLE_PERMISSIONS[role] },
        assignedLeadIds: data.assignedLeadIds,
        active: data.active !== false,
        createdAt: nowIso(),
        lastLogin: data.lastLogin,
        avatarInitials: data.avatarInitials || avatarInitialsFromName(name),
        avatarColor: data.avatarColor || "#64748b",
        passwordHash: data.passwordHash,
        mustChangePassword: data.mustChangePassword,
    };
    users.push(created);
    saveUsers(users);
    return created;
}
function updateUser(id, updates) {
    const users = getUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1)
        return null;
    const cur = users[idx];
    const name = updates.name !== undefined ? String(updates.name).trim() || cur.name : cur.name;
    const next = {
        ...cur,
        ...updates,
        name,
        email: updates.email !== undefined ? String(updates.email).trim() : cur.email,
        permissions: updates.permissions !== undefined ? updates.permissions : cur.permissions,
        assignedLeadIds: updates.assignedLeadIds !== undefined ? updates.assignedLeadIds : cur.assignedLeadIds,
        avatarInitials: updates.avatarInitials !== undefined
            ? updates.avatarInitials
            : avatarInitialsFromName(name),
        avatarColor: updates.avatarColor ?? cur.avatarColor,
    };
    users[idx] = next;
    saveUsers(users);
    return next;
}
function deleteUser(id) {
    return updateUser(id, { active: false }) !== null;
}
