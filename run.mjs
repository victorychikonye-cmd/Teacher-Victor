// End-to-end bot test: real bot code + real Postgres (schema, constraints, SQL functions).
// Only WhatsApp delivery and the AI are faked. See tests/bot/run.sh.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, ".build");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
cpSync(join(here, "../../supabase/functions"), join(build, "functions"), { recursive: true });
cpSync(join(here, "fake-supabase.mjs"), join(build, "fake-supabase.mjs"));
(function patch(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) patch(p);
    else if (p.endsWith(".ts")) writeFileSync(p, readFileSync(p, "utf8").replace('"npm:@supabase/supabase-js@2"', '"../../fake-supabase.mjs"'));
  }
})(join(build, "functions"));

/* ---- environment ---- */
Object.assign(process.env, {
  SUPABASE_URL: "http://fake", SUPABASE_SERVICE_ROLE_KEY: "fake", WA_VERIFY_TOKEN: "verify-me", WA_APP_SECRET: "app-secret",
  WA_ACCESS_TOKEN: "tok", WA_PHONE_NUMBER_ID: "999", ANTHROPIC_API_KEY: "key", CRON_SECRET: "cron-secret",
});
const handlers = [];
globalThis.Deno = { env: { get: (k) => process.env[k] }, serve: (h) => handlers.push(h) };

/* ---- fake WhatsApp + AI ---- */
const outbox = [];       // {to, text}
let aiCalls = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).includes("graph.facebook.com")) {
    outbox.push({ to: body.to, text: body.text?.body ?? `[template ${body.template?.name}]` });
    return new Response("{}", { status: 200 });
  }
  aiCalls++;
  const sys = body.system;
  let text = "TUTOR: step 1, step 2. What do you think comes next?";
  if (sys.includes("experienced ZIMSEC examiner writing")) text = "1. (4) Solve x^2-5x+6=0\n2. (6) Factorise x^2-9\nReply with your answers in ONE message, numbered 1., 2., 3. ...";
  if (sys.includes("fair ZIMSEC examiner marking")) {
    const ans = body.messages[0].content;
    text = ans.includes("STUDENT ANSWERS:\nwhat") ? '{"not_answers":true}'
      : '{"not_answers":false,"score":9,"out_of":10,"topic":"Quadratic equations","feedback":"Q1 4/4. Q2 5/6. Tip: check signs."}';
  }
  if (sys.includes("performance report")) text = "*Strengths* quadratics. *Needs work* geometry.";
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
};

await import(join(build, "functions/whatsapp-webhook/index.ts"));
const webhook = handlers.pop();
await import(join(build, "functions/daily-maintenance/index.ts"));
const maintenance = handlers.pop();

/* ---- helpers ---- */
const sql = (s) => execFileSync("psql", ["-h", process.env.PGHOST, "-p", process.env.PGPORT, "-U", "postgres", "-d", process.env.PGDATABASE,
  "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", s], { encoding: "utf8" }).trim();
let seq = 0;
async function post(payload, { sign = true, secret = "app-secret" } = {}) {
  const raw = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (sign) headers["x-hub-signature-256"] = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return webhook(new Request("http://fn/", { method: "POST", headers, body: raw }));
}
const payload = (from, text, id = `wamid.${++seq}`, type = "text") => ({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: "999" }, contacts: [{ wa_id: from, profile: { name: "Tendai" } }],
    messages: [{ from, id, type, ...(type === "text" ? { text: { body: text } } : {}) }] } }] }],
});
/** send a message from `from`; returns everything the bot sent to `who` (default: the sender) */
async function say(from, text, who = from) {
  outbox.length = 0;
  const res = await post(payload(from, text));
  assert.equal(res.status, 200);
  return outbox.filter((m) => m.to === who).map((m) => m.text).join("\n---\n");
}
const sentTo = (who) => outbox.filter((m) => m.to === who).map((m) => m.text).join("\n---\n");
let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log("  ✓", name); };
const has = (text, ...needles) => needles.forEach((n) => assert.ok(text.includes(n), `expected to find "${n}" in:\n${text}`));
const hasNot = (text, ...needles) => needles.forEach((n) => assert.ok(!text.includes(n), `did not expect "${n}" in:\n${text}`));

const S = "263771111111", ADMIN = "263700000001", OTHER = "263772222222", SEAT = "263773333333";
sql(`insert into zpay_wa_admins (phone, role) values ('${ADMIN}', 'owner')`);
sql(`insert into zpay_discounts (code, percent) values ('SAVE10', 10)`);

console.log("Webhook security");
{
  const get = (q) => webhook(new Request(`http://fn/?${q}`));
  ok("verification handshake accepts the right token", () => {});
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc")).status, 200);
  assert.equal(await (await get("hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc")).text(), "abc");
  ok("wrong verify token is refused", () => {});
  assert.equal((await get("hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc")).status, 403);
  ok("unsigned and wrongly signed posts are refused and do nothing", () => {});
  assert.equal((await post(payload(S, "hi"), { sign: false })).status, 401);
  assert.equal((await post(payload(S, "hi"), { secret: "wrong" })).status, 401);
  assert.equal(sql("select count(*) from wa_users"), "0");
}

console.log("Onboarding and the free tutor");
let r = await say(S, "hi");
ok("first message gets a welcome with privacy note and level choice", () => has(r, "Welcome to ZIMSEC AI Teacher", "never* ask for your EcoCash PIN", "1. Form 1", "6. Upper 6"));
r = await say(S, "9"); ok("invalid level is re-asked", () => has(r, "Please reply with a number from 1 to 6"));
r = await say(S, "4"); ok("level saved and menu shown with free quota", () => has(r, "(Form 4)", "Free questions left today: 5"));
assert.equal(sql(`select level from wa_users where phone='${S}'`), "Form 4");
{
  const id = "wamid.dup1"; outbox.length = 0;
  await post(payload(S, "Maths: what is 2+2?", id)); await post(payload(S, "Maths: what is 2+2?", id));
  ok("a message Meta delivers twice is answered once", () => assert.equal(outbox.filter((m) => m.to === S).length, 1));   // exactly one answer
}
// first question above used 1 free question (the duplicate was ignored)
assert.equal(sql(`select free_used from wa_users where phone='${S}'`), "1");
for (let i = 2; i <= 5; i++) r = await say(S, `Maths question ${i}`);
ok("free quota counts down to zero", () => has(r, "Free questions left today: 0"));
r = await say(S, "Maths question 6");
ok("the 6th free question hits the paywall, not the AI", () => has(r, "used your 5 free questions", "BUY"));
{ const before = aiCalls; await say(S, "Maths question 7"); ok("no AI cost is incurred once the free quota is used", () => assert.equal(aiCalls, before)); }
r = await say(S, "add 5 and 3"); // must reach the tutor logic (paywall), not the seat command
ok('"add 5 and 3" is not mistaken for the school-seat command', () => hasNot(r, "school subscription"));
r = await say(S, "1"); ok("a voice note / image gets a friendly text-only reply", () => {});
outbox.length = 0; await post(payload(S, "", undefined, "image"));
assert.ok(sentTo(S).includes("send your message as text"));

console.log("Buying a mock exam with EcoCash (nothing activates before verification)");
r = await say(S, "buy");
ok("prices are listed before any payment", () => has(r, "Services and prices*", "(Form 4)", "Mock Examination", "US$"));
const list = r.split("\n").filter((l) => /^\d+\. /.test(l));
const mockN = list.findIndex((l) => l.includes("Mock Examination")) + 1;
r = await say(S, String(mockN)); ok("a multi-unit service asks for quantity", () => has(r, "How many papers"));
r = await say(S, "99"); ok("quantity above the owner's limit is refused", () => has(r, "from 1 to 10"));
r = await say(S, "2"); ok("order summary shows unit price and total", () => has(r, "Order summary", "Mock Examination x 2", "Total:", "fixed once you continue"));
const total1 = r.match(/\*Total: (US\$[\d.]+)\*/)[1];
r = await say(S, "SAVE10"); ok("a valid discount code is applied before payment", () => has(r, "Discount: -10%"));
const total2 = r.match(/\*Total: (US\$[\d.]+)\*/)[1];
assert.ok(parseFloat(total2.slice(3)) < parseFloat(total1.slice(3)), "discount must reduce the total");
r = await say(S, "BADCODE"); ok("an invalid discount code is rejected without breaking the order", () => has(r, "Invalid or expired discount code"));
r = await say(S, "yes");
ok("payment instructions show the EcoCash number, reference and the never-share-PIN warning", () => has(r, "Pay with EcoCash", "0786610390", "Reference: *ZAT-", "Never share your EcoCash PIN"));
const ref = r.match(/ZAT-[A-Z0-9]{8}/)[0];
ok("the amount to pay is the previewed discounted total", () => has(r, `*${total2}*`));
r = await say(S, "3");  // student tries to use mock exams before paying (state is txn_id so "3" is not a menu key)
r = await say(S, "cancel");
r = await say(S, "3"); ok("mock exam is refused until payment is verified", () => has(r, "premium service", "BUY"));
assert.equal(sql(`select count(*) from zpay_entitlements`), "0");
assert.equal(sql(`select status from zpay_orders where reference='${ref}'`), "cancelled");

r = await say(S, "buy"); await say(S, String(mockN)); await say(S, "2"); await say(S, "SAVE10"); r = await say(S, "yes");
const ref2 = r.match(/ZAT-[A-Z0-9]{8}/)[0];
ok("a fresh order after cancelling gets a new reference", () => assert.notEqual(ref, ref2));
r = await say(S, "paid zz"); ok("an obviously bad transaction ID is refused", () => has(r, "does not look like"));
r = await say(S, "PAID MP261113.1000.A11111"); ok("PAID <id> asks which number paid", () => has(r, "Which EcoCash number did you pay from"));
r = await say(S, "12345"); ok("a bad payer number is refused with a clear message", () => has(r, "EcoCash number you paid from"));
outbox.length = 0;
r = await say(S, "same");
ok("student is told the payment is being verified, not activated", () => has(r, "verifying the payment", "activated only after verification"));
ok("the owner is alerted on WhatsApp with the details to check", () => has(sentTo(ADMIN), "Payment to verify", ref2, "MP261113.1000.A11111", "VERIFY " + ref2));
assert.equal(sql(`select count(*) from zpay_entitlements`), "0");
assert.equal(sql(`select status from zpay_orders where reference='${ref2}'`), "submitted");
r = await say(S, "3"); ok("still no access while the payment is only submitted", () => has(r, "premium service"));

console.log("Owner verification by WhatsApp");
r = await say(OTHER, "hi"); await say(OTHER, "2");
r = await say(OTHER, "buy"); await say(OTHER, "1"); await say(OTHER, "1"); r = await say(OTHER, "yes");
const refOther = r.match(/ZAT-[A-Z0-9]{8}/)[0];
await say(OTHER, "PAID MP261113.1000.A11111"); r = await say(OTHER, "0772222222");
ok("the same EcoCash transaction ID cannot be claimed twice", () => has(r, "already been used"));
r = await say(ADMIN, "pending"); ok("owner can list pending payments", () => has(r, ref2, "MP261113.1000.A11111"));
r = await say(S, `verify ${ref2}`); ok("a student cannot verify payments", () => hasNot(r, "verified"));
assert.equal(sql(`select status from zpay_orders where reference='${ref2}'`), "submitted");
outbox.length = 0;
r = await say(ADMIN, `verify ${ref2}`, ADMIN);
ok("owner verifies; student is notified with a receipt", () => has(sentTo(S), "Payment verified", "Mock Examination x 2 is now active", "PAYMENT RECEIPT", "RCT-", ref2, "MP261113.1000.A11111", "0786610390"));
ok("owner gets a confirmation", () => has(r, "verified"));
assert.equal(sql(`select units_remaining from zpay_entitlements`), "2");
outbox.length = 0; r = await say(ADMIN, `verify ${ref2}`);
ok("verifying again changes nothing and does not re-notify the student", () => { has(r, "already verified"); assert.equal(sentTo(S), ""); });
assert.equal(sql(`select count(*) from zpay_entitlements`), "1");
assert.equal(sql(`select count(*) from zpay_receipts`), "1");
outbox.length = 0; r = await say(ADMIN, `reject ${refOther} not found in statement`);
ok("owner can reject a payment with a reason; the student is told", () => has(sentTo(OTHER), "could not verify", "not found in statement"));
r = await say(ADMIN, "summary"); ok("owner gets a revenue summary", () => has(r, "Revenue summary", "Successful payments: 1", "Pending verification: 0"));
{
  sql(`insert into zpay_wa_admins (phone) values ('${S}')`);
  const refSelf = (await (async () => {
    await say(S, "buy"); await say(S, String(mockN)); await say(S, "1"); const x = await say(S, "yes"); return x.match(/ZAT-[A-Z0-9]{8}/)[0];
  })());
  await say(S, "PAID MP261113.2000.S22222"); await say(S, "same");
  r = await say(S, `verify ${refSelf}`);
  ok("an admin cannot verify their own payment", () => has(r, "cannot verify your own payment"));
  assert.equal(sql(`select status from zpay_orders where reference='${refSelf}'`), "submitted");
  sql(`delete from zpay_wa_admins where phone='${S}'`);
  await say(ADMIN, `reject ${refSelf} test`);
}

async function buy(from, label, qty) {
  let x = await say(from, "buy"); const n = x.split("\n").filter((l) => /^\d+\. /.test(l)).findIndex((l) => l.includes(label)) + 1;
  assert.ok(n > 0, `service ${label} not listed`);
  x = await say(from, String(n)); if (qty) x = await say(from, String(qty));
  x = await say(from, "yes"); return x.match(/ZAT-[A-Z0-9]{8}/)[0];
}
console.log("Using what was bought: mock exam, marking, report");
r = await say(S, "3"); ok("paid mock exam asks for subject and topic", () => has(r, "subject and topic"));
r = await say(S, "Maths - quadratic equations");
ok("the mock paper is generated", () => has(r, "Preparing your mock exam", "Solve x^2-5x+6=0", "numbered 1., 2."));
assert.equal(sql(`select units_remaining from zpay_entitlements`), "1");
r = await say(S, "what do you mean by question 2?"); ok("a clarifying question is not marked as answers", () => has(r, "waiting for your answers"));
r = await say(S, "1. x=2 or x=3  2. (x-3)(x+3)");
ok("answers are marked with a score and feedback", () => has(r, "Result: 9/10", "90%", "Tip: check signs"));
assert.equal(sql(`select kind || ':' || score || '/' || out_of from wa_activity where kind='mock'`), "mock:9/10");
r = await say(S, "5"); ok("a performance report must be bought first", () => has(r, "premium service"));
r = await say(S, "3"); await say(S, "Maths - algebra"); await say(S, "1. x=2"); // second credit, second marked paper
assert.equal(sql(`select status || ':' || units_remaining from zpay_entitlements`), "used:0");
r = await say(S, "3"); ok("with credits used up, the mock exam asks for payment again", () => has(r, "premium service"));

{ // buy and use a performance report (two marked papers exist by now)
  const rep = await buy(S, "Detailed Performance Report", 1);
  await say(S, "PAID MP261113.2500.R25252"); await say(S, "same");
  await say(ADMIN, `verify ${rep}`);
  r = await say(S, "5");
  ok("a bought performance report is built from the marked activity", () => has(r, "Performance report", "Strengths", "Needs work"));
  ok("and uses up its credit", () => assert.equal(sql(`select status from zpay_entitlements where service_name like '%Performance%'`), "used"));
}

console.log("Weekly access, school seats, expiry reminders");
const wk = await buy(S, "Premium Access - 1 Week");
await say(S, "PAID MP261113.3000.W33333"); await say(S, "same");
await say(ADMIN, `verify ${wk}`);
r = await say(S, "hello");
ok("after a weekly pack the menu says premium is active", () => has(r, "Premium access is active"));
for (let i = 0; i < 7; i++) r = await say(S, `Maths question ${i}`);
ok("premium students are not blocked by the free limit", () => hasNot(r, "free questions"));
r = await say(S, "status"); ok("status shows the active weekly pack with its end date", () => has(r, "Premium Access - 1 Week: until"));
r = await say(S, "receipt"); ok("receipt command returns the latest receipt", () => has(r, "PAYMENT RECEIPT", wk));

{ // price change by the owner must not touch an active subscription's agreed price
  const before = sql(`select agreed_price from zpay_entitlements where service_name like '%1 Week%'`);
  sql(`update zpay_services set margin_pct = 250, min_price = 3.9 where code='premium_weekly'`);
  assert.equal(sql(`select agreed_price from zpay_entitlements where service_name like '%1 Week%'`), before);
  ok("an active subscription keeps its agreed price after the owner raises prices", () => {});
  sql(`update zpay_services set margin_pct = 100, min_price = 2.0 where code='premium_weekly'`);
}

const sc = await buy(S, "School Subscription", 2);
await say(S, "PAID MP261113.4000.C44444"); await say(S, "same");
await say(ADMIN, `verify ${sc}`);
outbox.length = 0; r = await say(S, "add 0773333333");
ok("a school can add a student seat by number; the student is told", () => { has(r, "Added 0773333333", "Seats used: 1 of 2"); has(sentTo(SEAT), "premium access through your school"); });
r = await say(S, "add 0773333333"); ok("the same student cannot take two seats", () => has(r, "already has a seat"));
await say(S, "add 0774444444"); r = await say(S, "add 0775555555"); ok("seats beyond what was bought are refused", () => has(r, "seats are in use"));
await say(SEAT, "hi"); r = await say(SEAT, "2");
ok("the seat holder onboards by choosing a level, then gets premium", () => has(r, "Form 2"));
r = await say(SEAT, "menu"); ok("seat holder has premium access", () => has(r, "Premium access is active"));
r = await say(SEAT, "Science question"); ok("seat holder is not paywalled", () => hasNot(r, "free questions"));

{
  const bad = await maintenance(new Request("http://fn/", { method: "POST", headers: { "x-cron-secret": "nope" } }));
  ok("the maintenance job refuses calls without the secret", () => assert.equal(bad.status, 401));
  sql(`update zpay_entitlements set expires_at = now() + interval '2 days', notified_at = null where service_name like '%1 Week%'`);
  outbox.length = 0;
  const j = await (await maintenance(new Request("http://fn/", { method: "POST", headers: { "x-cron-secret": "cron-secret" } }))).json();
  ok("a weekly pack ending in 2 days triggers one WhatsApp reminder", () => { assert.ok(j.reminders_sent >= 1); has(sentTo(S), "Premium Access - 1 Week", "ends on", "BUY"); });
  outbox.length = 0;
  await maintenance(new Request("http://fn/", { method: "POST", headers: { "x-cron-secret": "cron-secret" } }));
  ok("the same reminder is not sent twice", () => assert.equal(sentTo(S).includes("Premium Access - 1 Week"), false));
  sql(`update zpay_entitlements set expires_at = now() - interval '1 minute' where service_name like '%1 Week%'`);
  await maintenance(new Request("http://fn/", { method: "POST", headers: { "x-cron-secret": "cron-secret" } }));
  assert.equal(sql(`select status from zpay_entitlements where service_name like '%1 Week%'`), "expired");
  ok("expired subscriptions are switched off by the job", () => {});
}

console.log("Data deletion and reminders");
r = await say(OTHER, "delete"); r = await say(OTHER, "yes");
ok("a student can erase their study data (payment records are kept)", () => has(r, "erased"));
assert.equal(sql(`select count(*) from wa_activity where user_id=(select id from wa_users where phone='${OTHER}')`), "0");
assert.equal(sql(`select count(*) from zpay_orders where user_id=(select id from wa_users where phone='${OTHER}')`) !== "0", true);

console.log(`\nAll ${passed} bot checks passed.`);
