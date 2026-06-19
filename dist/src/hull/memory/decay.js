"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDailyMemoryDecay = runDailyMemoryDecay;
exports.scheduleDailyDecay = scheduleDailyDecay;
const store_js_1 = require("./store.js");
function runDailyMemoryDecay() {
    const db = (0, store_js_1.getHullDb)();
    db.prepare("UPDATE facts SET strength = strength * 0.995 WHERE last_accessed < datetime('now', '-1 day') OR last_accessed IS NULL").run();
    db.prepare("UPDATE rules SET confidence = confidence * 0.999 WHERE last_reinforced < datetime('now', '-7 days') OR last_reinforced IS NULL").run();
    console.log("[hull/decay] daily memory decay applied");
}
function scheduleDailyDecay() {
    const MS_DAY = 24 * 60 * 60 * 1000;
    setInterval(() => runDailyMemoryDecay(), MS_DAY);
    console.log("[hull/decay] daily decay scheduled");
}
