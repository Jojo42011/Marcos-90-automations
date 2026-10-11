"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.enqueueDm = enqueueDm;
exports.saveDmReply = saveDmReply;
exports.drainDmQueue = drainDmQueue;
exports.dmQueueStatus = dmQueueStatus;
const node_fs_1 = require("node:fs");
const atomicJson_js_1 = require("./atomicJson.js");
const tenantData_js_1 = require("./tenantData.js");
let rows;
const file = () => (0, tenantData_js_1.dataPath)("inbound-dm-queue.json");
function load() {
    if (!rows) {
        const data = (0, node_fs_1.existsSync)(file()) ? JSON.parse((0, node_fs_1.readFileSync)(file(), "utf8")) : [];
        if (!Array.isArray(data))
            throw new Error("Invalid DM queue; preserved for recovery");
        rows = data.map(row => ({ ...row, status: row.status === "processing" ? "pending" : row.status }));
    }
    return rows;
}
function persist() { (0, atomicJson_js_1.atomicJson)(file(), load()); }
function enqueueDm(event) {
    const jobs = load();
    if (jobs.some(j => j.id === event.eventId))
        return false;
    const job = { id: event.eventId, event, status: "pending", attempts: 0, nextAt: Date.now() };
    jobs.push(job);
    try {
        persist();
    }
    catch (error) {
        jobs.pop();
        throw error;
    }
    return true;
}
function saveDmReply(job, reply) {
    job.reply = reply;
    persist();
}
async function drainDmQueue(process) {
    // Claim synchronously before yielding. New arrivals can still join the existing debounce window.
    {
        const due = load().filter(j => j.status === "pending" && j.nextAt <= Date.now()).slice(0, 32);
        if (!due.length)
            return;
        for (const job of due) {
            job.status = "processing";
            job.attempts++;
        }
        try {
            persist();
        }
        catch (error) {
            for (const job of due) {
                job.status = "pending";
                job.attempts--;
            }
            throw error;
        }
        // Existing debounce and per-conversation serialization remain in the pipeline.
        await Promise.all(due.map(async (job) => {
            try {
                await process(job);
                job.status = "done";
                job.error = undefined;
            }
            catch (error) {
                job.error = error instanceof Error ? error.message : String(error);
                job.status = job.attempts >= 5 ? "failed" : "pending";
                job.nextAt = Date.now() + Math.min(300000, 10000 * 2 ** job.attempts);
            }
            persist();
        }));
    }
}
function dmQueueStatus() {
    const jobs = load();
    return { counts: Object.fromEntries(["pending", "processing", "done", "failed"].map(status => [status, jobs.filter(j => j.status === status).length])),
        failed: jobs.filter(j => j.status === "failed").map(({ id, attempts, error }) => ({ id, attempts, error })) };
}
