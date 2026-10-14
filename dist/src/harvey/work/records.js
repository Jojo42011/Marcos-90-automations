"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workRecords = workRecords;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
/** Private, source-projected work product. It is not reusable teaching or new authorization. */
function workRecords(owner, chatId, input) {
    (0, store_js_1.get)("chat", owner, chatId);
    const collection = (0, store_js_1.text)(input.collection, "Collection", 80);
    const rows = () => (0, store_js_1.list)("work_record", owner).filter(r => r.chatId === chatId && r.collection === collection);
    if (input.action === "save") {
        // Only the agent loop supplies this projection after checking current tool evidence.
        const records = input._verifiedRecords;
        if (!Array.isArray(records) || !records.length || records.length > 30)
            throw Error("Save records through source evidence, not unsupported values");
        (0, store_js_1.workDb)().transaction(() => {
            for (const record of records) {
                const id = (0, crypto_1.createHash)("sha256").update(JSON.stringify([chatId, collection, record.key])).digest("hex");
                (0, store_js_1.put)("work_record", owner, { id, chatId, collection, ...record });
            }
        }).immediate();
        return { saved: records.length, total: rows().length, note: "Source values saved; this does not establish complete coverage or correct field interpretation. Read records before writing the final document." };
    }
    if (input.action !== "list")
        throw Error("Use save or list");
    const offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0)
        throw Error("Invalid offset");
    const all = rows(), items = [];
    let size = 0;
    for (const row of all.slice(offset, offset + 20)) {
        const n = JSON.stringify(row).length;
        if (items.length && size + n > 9000)
            break;
        items.push(row);
        size += n;
    }
    return { items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null, note: "Stored observations, not proof the source remains current. Coverage and missing sections must be checked separately." };
}
