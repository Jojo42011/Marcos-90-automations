"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.workRecords = workRecords;
const crypto_1 = require("crypto");
const store_js_1 = require("./store.js");
const fs_1 = require("fs");
const path_1 = require("path");
const files_js_1 = require("./files.js");
/** Private, source-projected work product. It is not reusable teaching or new authorization. */
function workRecords(owner, chatId, input) {
    (0, store_js_1.get)("chat", owner, chatId);
    const collection = (0, store_js_1.text)(input.collection, "Collection", 80);
    const rows = () => (0, store_js_1.list)("work_record", owner).filter(r => r.chatId === chatId && r.collection === collection);
    if (input.action === "export") {
        const all = rows().sort((a, b) => a.key.localeCompare(b.key));
        if (!all.length)
            throw Error("No saved records in this collection. Retrieve and save the requested data first.");
        const columns = input.columns ?? [...new Set(all.flatMap(r => Object.keys(r.fields)))];
        if (!Array.isArray(columns) || !columns.length || columns.length > 30 || columns.some(c => typeof c !== "string" || !c.length || c.length > 80) || new Set(columns).size !== columns.length)
            throw Error("Use 1–30 unique saved field names as columns");
        if (columns.some(c => !all.some(r => Object.prototype.hasOwnProperty.call(r.fields, c))))
            throw Error("A requested column has never been observed. Retrieve that field before exporting it.");
        const cell = (v) => { let value = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[\s]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value))
            value = "'" + value; return '"' + value.replace(/"/g, '""') + '"'; };
        const csv = '\uFEFF' + [['source_id', ...columns].map(cell).join(','), ...all.map(r => [r.key, ...columns.map(c => Object.prototype.hasOwnProperty.call(r.fields, c) ? r.fields[c] : null)].map(cell).join(','))].join('\r\n') + '\r\n';
        const hash = (0, crypto_1.createHash)('sha256').update(csv).digest('hex'), name = 'records-' + hash.slice(0, 20) + '.csv', path = (0, path_1.join)((0, files_js_1.filesDir)(owner, chatId), name);
        if (!(0, fs_1.existsSync)(path))
            (0, fs_1.writeFileSync)(path, csv, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        if ((0, fs_1.readFileSync)((0, files_js_1.filePath)(owner, chatId, name), 'utf8') !== csv)
            throw Error('Export verification failed');
        return { file: name, download: `/api/harvey/work/files/${chatId}/${name}`, rows: all.length, columns, sha256: hash,
            missingByColumn: Object.fromEntries(columns.map(c => [c, all.filter(r => !Object.prototype.hasOwnProperty.call(r.fields, c) || r.fields[c] == null).length])),
            note: 'Verified CSV of saved observations only, not proof of full source coverage or correct filters. Unread fields remain blank; confirmed empty source strings remain empty. Formula-like cells are escaped for spreadsheet safety. Reconcile expected counts and exclusions before reporting the requested export complete.' };
    }
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
        throw Error("Use save, list or export");
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
