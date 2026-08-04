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

import { randomUUID } from "crypto";
import { getSystemState, setSystemState } from "./memory/store.js";

export interface StandingOrder {
  id: string;
  rule: string;
  createdAt: string;
}

const STATE_KEY = "harvey_standing_orders";
const MAX_ORDERS = 30;
const MAX_RULE_CHARS = 300;

export function listStandingOrders(): StandingOrder[] {
  try {
    const raw = getSystemState(STATE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (o): o is StandingOrder =>
        o && typeof o.id === "string" && typeof o.rule === "string",
    );
  } catch {
    return [];
  }
}

function save(orders: StandingOrder[]): void {
  setSystemState(STATE_KEY, JSON.stringify(orders));
}

export function addStandingOrder(rule: string): StandingOrder | { error: string } {
  const text = rule.trim();
  if (!text) return { error: "rule required" };
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
  const order: StandingOrder = { id: randomUUID(), rule: text, createdAt: new Date().toISOString() };
  save([...orders, order]);
  return order;
}

export function removeStandingOrder(idOrRule: string): boolean {
  const needle = idOrRule.trim().toLowerCase();
  if (!needle) return false;
  const orders = listStandingOrders();
  const kept = orders.filter(
    (o) => o.id !== idOrRule && !o.rule.toLowerCase().includes(needle),
  );
  if (kept.length === orders.length) return false;
  save(kept);
  return true;
}

export function standingOrderRules(): string[] {
  return listStandingOrders().map((o) => o.rule);
}
