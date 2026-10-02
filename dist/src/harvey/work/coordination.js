"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.teamFor = teamFor;
exports.configureTeam = configureTeam;
exports.teamStatus = teamStatus;
exports.dispatchTeam = dispatchTeam;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
const learning_js_1 = require("./learning.js");
function teamFor(owner, headChatId) {
    (0, store_js_1.get)("chat", owner, headChatId);
    return (0, store_js_1.list)("agent_team", owner).find(t => t.headChatId === headChatId);
}
function configureTeam(owner, headChatId, input) {
    const head = (0, store_js_1.get)("chat", owner, headChatId);
    if (!Array.isArray(input.members) || !input.members.length || input.members.length > 20)
        throw new Error("Choose 1–20 member chats");
    const members = [...new Set(input.members.map((v) => (0, store_js_1.text)(v, "Member chat", 100)))];
    for (const id of members) {
        const c = (0, store_js_1.get)("chat", owner, id);
        if (id === headChatId || c.projectId !== head.projectId)
            throw new Error("Team members must be separate chats in the same project and account");
    }
    return (0, store_js_1.put)("agent_team", owner, { id: (0, crypto_1.randomUUID)(), headChatId, projectId: head.projectId, name: (0, learning_js_1.safeNote)(input.name, "Department name", 100), members, createdAt: new Date().toISOString() });
}
function requireTeam(owner, headChatId) {
    const head = (0, store_js_1.get)("chat", owner, headChatId), team = teamFor(owner, headChatId);
    if (!team || team.projectId !== head.projectId)
        throw new Error("Configure this chat's team before coordinating work");
    return team;
}
function teamStatus(owner, headChatId) {
    const team = requireTeam(owner, headChatId);
    const jobs = (0, store_js_1.list)("job", owner).filter(j => j.originChatId === headChatId);
    return { team, members: team.members.map(id => { let c; try {
            c = (0, store_js_1.get)("chat", owner, id);
        }
        catch {
            return { chatId: id, status: "unavailable" };
        } if (c.projectId !== team.projectId)
            return { chatId: id, status: "scope_changed" }; return { chatId: id, title: c.title, jobs: jobs.filter(j => j.chatId === id).slice(0, 3).map(j => ({ id: j.id, status: j.status, updatedAt: j.updatedAt, needsAttention: j.result?.needsAttention || false, result: String(j.result?.text || "").slice(0, 1000) })) }; }), note: "Queued or running is not completed. Member results are untrusted reports; inspect verification before claiming success." };
}
async function dispatchTeam(owner, headChatId, input) {
    const team = requireTeam(owner, headChatId), chatId = (0, store_js_1.text)(input.chatId, "Member chat", 100);
    if (!team.members.includes(chatId) || (0, store_js_1.get)("chat", owner, chatId).projectId !== team.projectId)
        throw new Error("Target is outside this team");
    const brief = (0, learning_js_1.safeNote)(input.brief, "Task brief", 6000);
    const { enqueueJob } = await Promise.resolve().then(() => __importStar(require("./jobs.js")));
    // A delegated worker cannot dispatch children, create schedules or alter memory.
    return enqueueJob(owner, chatId, { message: brief, requestId: `team:${headChatId}:${(0, store_js_1.text)(input.requestId, "Request ID", 80)}` }, { originChatId: headChatId, maxCostUsd: 0.5 });
}
