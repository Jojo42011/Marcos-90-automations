/** Verify Harvey tool approvals, including expiration and replay refusal. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = mkdtempSync(path.join(tmpdir(), "harvey-cron-"));
delete process.env.HARVEY_APPROVAL_REQUIRED;
delete process.env.HARVEY_APPROVAL_STRICT;

const require_ = createRequire(import.meta.url);
const approval = require_("../dist/src/hull/approval.js");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ───────────────────────── APPROVAL GATE ─────────────────────────
console.log("\nAPPROVAL — enforced in code, because a prompt is not a control");

approval.__resetApprovals();

check("sending an email needs approval", approval.needsApproval("gmail_send", { to: "a@b.com" }));
check("sending WhatsApp needs approval", approval.needsApproval("whatsapp_send", { to: "jahan" }));
check("queueing a text to a contact needs approval", approval.needsApproval("schedule_message", { leadId: "L1" }));
check("running a script needs approval", approval.needsApproval("run_script", {}));
check("deleting a file needs approval", approval.needsApproval("delete_file", { path: "x" }));
check("changing agent logic needs approval", approval.needsApproval("change_agent_logic", {}));

check("reading a lead does NOT need approval", !approval.needsApproval("get_lead", { id: "L1" }));
check("searching does NOT need approval", !approval.needsApproval("search_leads", { query: "x" }));
check("an internal CRM write does NOT need approval", !approval.needsApproval("update_lead", { id: "L1" }));

/* The argument-aware case: one tool, two very different blast radii. */
check("crm_api GET is a read", approval.classifyToolCall("crm_api", { method: "GET", path: "/api/leads" }).level === "low");
check("crm_api DELETE is high risk", approval.classifyToolCall("crm_api", { method: "DELETE", path: "/api/leads/1" }).level === "high");
check("crm_api POST needs approval", approval.needsApproval("crm_api", { method: "POST", path: "/api/leads" }));
check("and the reason names the method and path",
  /DELETE/.test(approval.classifyToolCall("crm_api", { method: "DELETE", path: "/api/x" }).reason));

check("a browser click is medium risk", approval.classifyToolCall("browser_click", {}).level === "medium");
check("medium is allowed by default", !approval.needsApproval("browser_click", {}));
process.env.HARVEY_APPROVAL_STRICT = "true";
check("strict mode holds medium risk too", approval.needsApproval("browser_click", {}));
delete process.env.HARVEY_APPROVAL_STRICT;

process.env.HARVEY_APPROVAL_REQUIRED = "false";
check("the kill switch disables the gate", !approval.needsApproval("gmail_send", { to: "a@b.com" }));
delete process.env.HARVEY_APPROVAL_REQUIRED;
check("and removing it re-arms the gate", approval.needsApproval("gmail_send", { to: "a@b.com" }));

const req = approval.requestApproval({
  tool: "gmail_send",
  args: { to: "buyer@example.com", subject: "Your listing alerts" },
  sessionId: "s1",
});
check("an approval is created pending", req.status === "pending");
check("the summary is written for a human, not a JSON dump",
  req.summary === 'Email "Your listing alerts" to buyer@example.com', req.summary);
check("it appears in the pending list", approval.listPendingApprovals().some((a) => a.id === req.id));
check("it is scoped to its session", approval.listPendingApprovals("s1").length === 1);
check("and not to another session", approval.listPendingApprovals("other").length === 0);

const held = approval.heldToolResultText(req);
check("the model is told the action did NOT run", /has NOT run/.test(held));
check("the model is told not to work around it", /work around it/.test(held));
check("the model is told not to claim it is done", /do not tell the operator it is done/i.test(held));

check("approving marks it approved", approval.decideApproval(req.id, "approved", { by: "marco" }).status === "approved");
check("it leaves the pending list once decided", !approval.listPendingApprovals().some((a) => a.id === req.id));
check("the same approval cannot be decided twice (no replay)", approval.decideApproval(req.id, "approved") === null);

const denied = approval.requestApproval({ tool: "run_script", args: {}, sessionId: "s1" });
check("denying records the reason", approval.decideApproval(denied.id, "denied", { reason: "not now" }).denyReason === "not now");

/* Fails closed: an approval that expired is not executable. */
const stale = approval.requestApproval({ tool: "gmail_send", args: { to: "x@y.com" }, sessionId: "s2" });
stale.expiresAt = new Date(Date.now() - 1000).toISOString();
check("an expired approval cannot be approved (fails closed)", approval.decideApproval(stale.id, "approved") === null);
check("and it is not listed as pending", !approval.listPendingApprovals().some((a) => a.id === stale.id));

rmSync(tmp, { recursive: true, force: true });

const total = pass + fail;
console.log(`\n${pass}/${total} checks passed`);
if (fail) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
