"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGCITrackerSummary = getGCITrackerSummary;
const financeStore_js_1 = require("../../core/financeStore.js");
function getGCITrackerSummary() {
    return (0, financeStore_js_1.getGCISummary)();
}
