/**
 * E2E /simulate tests for ack close-out flow. Run while server is up on :3000.
 */
const BASE = "http://localhost:3000/simulate";

function ig(uid, msg) {
  return {
    platform: "instagram",
    user_id: uid,
    message: msg,
    comment_or_dm: "dm",
  };
}

async function simulate(uid, msg, label) {
  const t0 = Date.now();
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ig(uid, msg)),
  });
  const data = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  const line = {
    test: label,
    user_id: uid,
    inbound: msg,
    status: res.status,
    reply: data.reply ?? null,
    elapsed_ms: ms,
  };
  console.log(JSON.stringify(line));
  return line;
}

async function buildPhoneCapturedThread(uid) {
  console.log("--- BUILD phone-captured thread for", uid, "---");
  await simulate(uid, "how much is this home", "build:price");
  await simulate(uid, "yes please", "build:yes");
  await simulate(uid, "2105551234", "build:phone");
}

async function testA() {
  const uid = `e2e-a-${Date.now()}`;
  console.log("\n=== TEST A: phone capture → ack → second ack silence ===");
  await buildPhoneCapturedThread(uid);
  await simulate(uid, "perfect thank you", "A:first-ack");
  await simulate(uid, "ok thanks", "A:second-ack");
}

async function testC() {
  const uid = `e2e-c-${Date.now()}`;
  console.log("\n=== TEST C: pre-phone breakdown ack → closeout → silence ===");
  await simulate(uid, "how much is this home", "C:price");
  await simulate(uid, "perfect thank you so much", "C:first-ack");
  await simulate(uid, "okay thank you", "C:second-ack");
}

async function testB() {
  const uid = `e2e-b-${Date.now()}`;
  console.log("\n=== TEST B: debounced dual ack in one burst ===");
  await buildPhoneCapturedThread(uid);

  const payload = (msg) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ig(uid, msg)),
  });

  console.log("--- firing thanks + appreciate it within debounce window ---");
  const t0 = Date.now();
  const p1 = fetch(BASE, payload("thanks")).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return {
      label: "B:debounce-req1",
      inbound: "thanks",
      reply: data.reply ?? null,
      elapsed_ms: Date.now() - t0,
      status: res.status,
    };
  });
  await new Promise((r) => setTimeout(r, 2000));
  const p2 = fetch(BASE, payload("appreciate it")).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return {
      label: "B:debounce-req2",
      inbound: "appreciate it",
      reply: data.reply ?? null,
      elapsed_ms: Date.now() - t0,
      status: res.status,
    };
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  console.log(JSON.stringify(r1));
  console.log(JSON.stringify(r2));
  console.log(
    JSON.stringify({
      test: "B:combined_expectation",
      combined_message: "thanks appreciate it",
      note: "pipeline joins queue with space",
    }),
  );
}

async function main() {
  await testA();
  await testC();
  await testB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
