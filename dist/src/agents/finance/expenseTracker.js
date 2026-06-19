"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExpenseTrackerSummary = getExpenseTrackerSummary;
const financeStore_js_1 = require("../../core/financeStore.js");
function getExpenseTrackerSummary() {
    return (0, financeStore_js_1.getExpenseSummary)();
}
