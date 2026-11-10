import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const source = readFileSync(
  new URL("../web/smartposter/model.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const model = await import(
  "data:text/javascript;base64," + Buffer.from(compiled).toString("base64")
);
assert.equal(model.weekDates("2026-11-08")[0], "2026-11-02");
assert.equal(model.weekDates("2026-11-08", 1)[0], "2026-11-09");
assert.equal(model.weekDates("2026-12-31", 1)[0], "2027-01-04");
assert.deepEqual(model.localParts("2026-11-07T16:00:00Z", "America/Chicago"), {
  localDate: "2026-11-07",
  localTime: "10:00",
});
assert.deepEqual(model.localParts("2026-07-07T16:00:00Z", "America/Chicago"), {
  localDate: "2026-07-07",
  localTime: "11:00",
});
assert.deepEqual(model.localParts("bad date", "America/Chicago"), {
  localDate: "",
  localTime: "",
});
const accounts = [
  { id: "a", platform: "instagram" },
  { id: "b", platform: "instagram" },
];
const post = {
  id: "draft-1",
  title: "Old title",
  caption: "Old caption",
  accountIds: ["b"],
  platforms: ["instagram"],
  status: "ready",
};
assert.equal(model.matches(post, "a", "all", accounts), false);
assert.equal(model.matches(post, "b", "all", accounts), true);
assert.equal(model.matches(post, "b", "failed", accounts), false);
assert.equal(
  model.matches({ ...post, accountIds: [] }, "a", "all", accounts),
  true,
);
let plan = model.planFor(post, "America/Chicago", "2026-11-12");
assert.equal(plan.localDate, "2026-11-12");
assert.equal(plan.localTime, "");
assert.throws(() => model.payload(plan, true), /both a day and a time/);
plan = {
  ...plan,
  title: "New title",
  caption: "Edited before scheduling",
  localTime: "10:00",
  accountIds: ["a"],
};
assert.throws(
  () => model.payload({ ...plan, accountIds: [] }, true),
  /at least one account/,
);
assert.equal(
  model.payload({ ...plan, localDate: "", localTime: "" }).scheduledFor,
  null,
);
assert.equal(model.safeURL("javascript:alert(1)"), "");
assert.equal(
  model.safeURL("https://example.com/video"),
  "https://example.com/video",
);
const originalFetch = globalThis.fetch,
  requests = [];
try {
  globalThis.fetch = async (path, options) => {
    requests.push({ path, ...options });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await model.api(
    "POST",
    "/api/smartposter/posts/draft-1/schedule",
    model.payload(plan, true),
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].body), plan);
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "Publishing status is uncertain; reconcile first.",
    }),
  });
  await assert.rejects(
    () =>
      model.api(
        "POST",
        "/api/smartposter/posts/draft-1/schedule",
        model.payload(plan, true),
      ),
    /reconcile first/,
  );
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  "Smart Poster UI: timezone boundaries, account subsets, plan validation, current-form scheduling and error propagation passed.",
);
