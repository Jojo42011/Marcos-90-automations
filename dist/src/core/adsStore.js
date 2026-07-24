"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAdCampaigns = getAdCampaigns;
exports.getAdCampaignById = getAdCampaignById;
exports.createAdCampaign = createAdCampaign;
exports.updateAdCampaign = updateAdCampaign;
exports.deleteAdCampaign = deleteAdCampaign;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function resolveAdsDbPath() {
    const env = process.env.ADS_DB_PATH?.trim();
    if (env)
        return env;
    if ((0, fs_1.existsSync)("/data"))
        return "/data/ads.db";
    const localDir = path_1.default.join(process.cwd(), "data");
    (0, fs_1.mkdirSync)(localDir, { recursive: true });
    return path_1.default.join(localDir, "ads.db");
}
let db = null;
function initSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS ad_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'both',
      objective TEXT NOT NULL DEFAULT 'leads',
      status TEXT NOT NULL DEFAULT 'draft',
      daily_budget REAL NOT NULL DEFAULT 0,
      total_budget REAL NOT NULL DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      audience TEXT,
      creative_notes TEXT,
      linked_post_id TEXT,
      linked_post_caption TEXT,
      linked_post_cover_url TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ad_campaigns_status ON ad_campaigns(status);
  `);
}
function getDb() {
    if (!db) {
        db = new better_sqlite3_1.default(resolveAdsDbPath());
        initSchema(db);
    }
    return db;
}
function genId() {
    return `ad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
function rowToCampaign(r) {
    return {
        id: String(r.id),
        name: String(r.name),
        platform: r.platform || "both",
        objective: r.objective || "leads",
        status: r.status || "draft",
        dailyBudget: Number(r.daily_budget) || 0,
        totalBudget: Number(r.total_budget) || 0,
        startDate: String(r.start_date || ""),
        endDate: String(r.end_date || ""),
        audience: String(r.audience || ""),
        creativeNotes: String(r.creative_notes || ""),
        linkedPostId: r.linked_post_id ? String(r.linked_post_id) : null,
        linkedPostCaption: r.linked_post_caption ? String(r.linked_post_caption) : null,
        linkedPostCoverUrl: r.linked_post_cover_url ? String(r.linked_post_cover_url) : null,
        createdBy: r.created_by ? String(r.created_by) : null,
        createdAt: String(r.created_at),
        updatedAt: String(r.updated_at),
    };
}
function getAdCampaigns() {
    const rows = getDb().prepare(`SELECT * FROM ad_campaigns ORDER BY created_at DESC`).all();
    return rows.map(rowToCampaign);
}
function getAdCampaignById(id) {
    const row = getDb().prepare(`SELECT * FROM ad_campaigns WHERE id = ?`).get(id);
    return row ? rowToCampaign(row) : null;
}
function createAdCampaign(input) {
    const now = new Date().toISOString();
    const id = genId();
    getDb()
        .prepare(`INSERT INTO ad_campaigns
        (id, name, platform, objective, status, daily_budget, total_budget, start_date, end_date,
         audience, creative_notes, linked_post_id, linked_post_caption, linked_post_cover_url,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.name.trim(), input.platform, input.objective, input.status || "draft", input.dailyBudget || 0, input.totalBudget || 0, input.startDate || "", input.endDate || "", input.audience || "", input.creativeNotes || "", input.linkedPostId || null, input.linkedPostCaption || null, input.linkedPostCoverUrl || null, input.createdBy || null, now, now);
    return getAdCampaignById(id);
}
function updateAdCampaign(id, updates) {
    const cur = getAdCampaignById(id);
    if (!cur)
        return null;
    const next = {
        name: updates.name !== undefined ? updates.name.trim() : cur.name,
        platform: updates.platform !== undefined ? updates.platform : cur.platform,
        objective: updates.objective !== undefined ? updates.objective : cur.objective,
        status: updates.status !== undefined ? updates.status : cur.status,
        daily_budget: updates.dailyBudget !== undefined ? updates.dailyBudget : cur.dailyBudget,
        total_budget: updates.totalBudget !== undefined ? updates.totalBudget : cur.totalBudget,
        start_date: updates.startDate !== undefined ? updates.startDate : cur.startDate,
        end_date: updates.endDate !== undefined ? updates.endDate : cur.endDate,
        audience: updates.audience !== undefined ? updates.audience : cur.audience,
        creative_notes: updates.creativeNotes !== undefined ? updates.creativeNotes : cur.creativeNotes,
    };
    getDb()
        .prepare(`UPDATE ad_campaigns SET name=?, platform=?, objective=?, status=?, daily_budget=?, total_budget=?,
        start_date=?, end_date=?, audience=?, creative_notes=?, updated_at=? WHERE id=?`)
        .run(next.name, next.platform, next.objective, next.status, next.daily_budget, next.total_budget, next.start_date, next.end_date, next.audience, next.creative_notes, new Date().toISOString(), id);
    return getAdCampaignById(id);
}
function deleteAdCampaign(id) {
    const res = getDb().prepare(`DELETE FROM ad_campaigns WHERE id = ?`).run(id);
    return res.changes > 0;
}
