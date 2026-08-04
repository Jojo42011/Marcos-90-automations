"use strict";
/**
 * Standing orders — live self-modification (playbook §8).
 *
 * "Harvey, stop doing X" is an instruction, not a remark. Each order is stored
 * as ONE plain-English rule, readable and retractable, and injected into every
 * future generation via buildFounderSystemPrompt. Deliberately not free-form
 * prompt editing: the model adds a rule or removes a rule, nothing else, so a
 * bad day can't rewrite Harvey's identity.
 *
 * Stored as JSON in aethon-memory.db system_state (survives restarts; small
 * enough that a table would be ceremony).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStandingOrders = listStandingOrders;
exports.addStandingOrder = addStandingOrder;
exports.removeStandingOrder = removeStandingOrder;
exports.standingOrderRules = standingOrderRules;
const crypto_1 = require("crypto");
const store_js_1 = require("./memory/store.js");
const STATE_KEY = "harvey_standing_orders";
const MAX_ORDERS = 30;
const MAX_RULE_CHARS = 300;
function listStandingOrders() {
    try {
        const raw = (0, store_js_1.getSystemState)(STATE_KEY);
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((o) => o && typeof o.id === "string" && typeof o.rule === "string");
    }
    catch {
        return [];
    }
}
function save(orders) {
    (0, store_js_1.setSystemState)(STATE_KEY, JSON.stringify(orders));
}
function addStandingOrder(rule) {
    const text = rule.trim();
    if (!text)
        return { error: "rule required" };
    if (text.length > MAX_RULE_CHARS) {
        return { error: `A standing order is one rule, under ${MAX_RULE_CHARS} characters. Split it.` };
    }
    const orders = listStandingOrders();
    if (orders.length >= MAX_ORDERS) {
        return { error: `Standing order limit (${MAX_ORDERS}) reached. Remove one first.` };
    }
    if (orders.some((o) => o.rule.toLowerCase() === text.toLowerCase())) {
        return { error: "That standing order already exists." };
    }
    const order = { id: (0, crypto_1.randomUUID)(), rule: text, createdAt: new Date().toISOString() };
    save([...orders, order]);
    return order;
}
function removeStandingOrder(idOrRule) {
    const needle = idOrRule.trim().toLowerCase();
    if (!needle)
        return false;
    const orders = listStandingOrders();
    const kept = orders.filter((o) => o.id !== idOrRule && !o.rule.toLowerCase().includes(needle));
    if (kept.length === orders.length)
        return false;
    save(kept);
    return true;
}
function standingOrderRules() {
    return listStandingOrders().map((o) => o.rule);
}
