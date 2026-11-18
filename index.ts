// deno-lint-ignore-file no-explicit-any
// ZIMSEC AI Teacher: WhatsApp webhook. Receives messages from the WhatsApp Cloud API, runs the
// conversation (tutor, assignments, mock exams, revision, reports), takes EcoCash payments in chat and
// lets the owner verify payments by WhatsApp. Every price and every access decision is made in the database.
import { createClient } from "npm:@supabase/supabase-js@2";
import { notify, sendText, verifySignature } from "../_shared/wa.ts";
import { ask, generatorSystem, markerSystem, parseJson, reportSystem, tutorSystem } from "../_shared/ai.ts";
import * as T from "../_shared/text.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Row = Record<string, any>;
/** An error whose message is safe to show to the person (raised on purpose by our SQL functions). */
class UserError extends Error {}

const SERVICE_ORDER = ["premium_tutoring", "extra_assignment", "mock_exam", "advanced_revision", "performance_report",
  "premium_daily", "premium_weekly", "premium_monthly", "school_term"];
const YES = new Set(["yes", "y", "ok", "okay", "confirm", "hongu", "yebo"]);
const TXN_RE = /^[A-Za-z0-9.-]{6,30}$/;
const FREE_CAP_PER_DAY = 150; // hard fair-use cap on AI replies per student per day

/* ------------------------------ helpers ------------------------------ */
const reply = (u: Row, text: string) => sendText(u.phone, text);

async function save(u: Row, patch: Row) {
  Object.assign(u, patch);
  const { error } = await db.from("wa_users").update(patch).eq("id", u.id);
  if (error) throw error;
}
const setState = (u: Row, state: string, ctx: Row = {}) => save(u, { state, ctx });

async function rpc(name: string, args: Row): Promise<any> {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    if (error.code === "P0001") throw new UserError(error.message); // raise exception in our SQL
    throw error;
  }
  return data;
}

async function cfg(): Promise<Row> {
  const { data, error } = await db.from("zpay_settings").select("*").single();
  if (error) throw error;
  return { ...data, levels: Object.keys(data.level_multipliers).sort() };
}

async function accessCodes(): Promise<string[]> {
  const { data } = await db.from("zpay_services").select("code").eq("kind", "access").eq("enabled", true);
  return (data ?? []).map((r: Row) => r.code);
}
async function hasAccess(u: Row, codes?: string[]): Promise<boolean> {
  codes ??= await accessCodes();
  if (!codes.length) return false;
  return (await rpc("zpay_has_access", { p_user: u.id, p_services: codes })) === true;
}

/** Can this student use a one-off feature right now? Does not consume anything. */
async function entitle(u: Row, code: string): Promise<{ ok: boolean; via?: "access" | "credit"; off?: boolean }> {
  const { data: svc } = await db.from("zpay_services").select("id,enabled,covered_by_access").eq("code", code).maybeSingle();
  if (!svc || !svc.enabled) return { ok: false, off: true };
  if (svc.covered_by_access && (await hasAccess(u))) return { ok: true, via: "access" };
  const { data } = await db.from("zpay_entitlements").select("id").eq("user_id", u.id).eq("service_id", svc.id)
    .eq("status", "active").gt("units_remaining", 0).limit(1);
  return data?.length ? { ok: true, via: "credit" } : { ok: false };
}

async function quote(u: Row, code: string, units: number, discount?: string | null): Promise<Row> {
  const rows = await rpc("zpay_quote", { p_user: u.id, p_service: code, p_units: units, p_level: u.level, p_discount: discount ?? null });
  return rows[0];
}

const freeUsedToday = (u: Row) => (u.free_day === T.harareDay() ? u.free_used : 0);

/* ------------------------------ menu & level ------------------------------ */
async function showMenu(u: Row, c?: Row) {
  c ??= await cfg();
  await setState(u, "tutor", {});
  const premium = await hasAccess(u);
  await reply(u, T.menu(u.level, premium ? null : Math.max(0, c.free_daily_questions - freeUsedToday(u))));
}

async function chooseLevel(u: Row, t: string, c: Row) {
  const n = /^\d+$/.test(t) ? +t : 0;
  const level = c.levels[n - 1] ?? c.levels.find((l: string) => l.toLowerCase() === t);
  if (!level) return reply(u, T.badLevel(c.levels));
  await save(u, { level, state: "tutor", ctx: {}, history: [] });
  return showMenu(u, c);
}

async function menuChoice(u: Row, n: number, c: Row) {
  switch (n) {
    case 1: return reply(u, "Type your question and I will explain it step by step. Please mention the subject.\nExample: _Maths: how do I solve x^2 - 5x + 6 = 0?_");
    case 2: return startFeature(u, "assignment", c);
    case 3: return startFeature(u, "mock", c);
    case 4: return startFeature(u, "revision", c);
    case 5: return startFeature(u, "report", c);
    case 6: return showServices(u, c);
    default: return showStatus(u);
  }
}

/* ------------------------------ tutor ------------------------------ */
async function tutor(u: Row, text: string, c: Row) {
  const today = T.harareDay();
  const aiCount = u.ai_day === today ? u.ai_count : 0;
  if (aiCount >= FREE_CAP_PER_DAY) return reply(u, T.dailyCap);

  let mode: "access" | "session" | "free" | "credit" | null = null;
  if (await hasAccess(u)) mode = "access";
  else if (u.session_until && new Date(u.session_until) > new Date()) mode = "session";
  else if (freeUsedToday(u) < c.free_daily_questions) mode = "free";
  else {
    const e = await entitle(u, "premium_tutoring");
    if (e.ok && e.via === "credit") mode = "credit";
  }
  if (!mode) return reply(u, T.paywallTutor(c.free_daily_questions));

  const history: any[] = Array.isArray(u.history) ? u.history.slice(-6) : [];
  const answer = await ask(tutorSystem(u.level), [...history, { role: "user", content: text }], 700);

  // Usage is recorded only after the AI answered successfully.
  const patch: Row = {
    ai_day: today, ai_count: aiCount + 1,
    history: [...history, { role: "user", content: text.slice(0, 500) }, { role: "assistant", content: answer.slice(0, 1200) }].slice(-6),
  };
  let note = "";
  if (mode === "free") {
    patch.free_day = today;
    patch.free_used = freeUsedToday(u) + 1;
    note = `\n\n_Free questions left today: ${Math.max(0, c.free_daily_questions - patch.free_used)}_`;
  }
  if (mode === "credit") {
    await rpc("zpay_consume_unit", { p_user: u.id, p_service: "premium_tutoring" });
    patch.session_until = new Date(Date.now() + 30 * 60_000).toISOString();
    note = "\n\n_Premium tutoring session started: unlimited questions for 30 minutes._";
  }
  await save(u, patch);
  await reply(u, answer + note);
}

/* ------------------------------ assignments, mock exams, revision, report ------------------------------ */
async function startFeature(u: Row, key: string, c: Row) {
  const f = T.feature[key];
  const e = await entitle(u, f.code);
  if (!e.ok) {
    if (e.off) return reply(u, T.unavailable(f.name));
    const q = await quote(u, f.code, 1).catch(() => null);
    return reply(u, T.needsPayment(f.name, q ? T.money(q.amount, q.currency) : null));
  }
  if (key === "report") return report(u, f);
  await setState(u, "gen", { kind: key });
  return reply(u, f.ask!);
}

async function generate(u: Row, text: string) {
  const key = u.ctx.kind as "assignment" | "mock" | "revision";
  const f = T.feature[key];
  if (!f) return showMenu(u);
  if (text.length > 200) return reply(u, "Please send just the subject and topic in one short line. (Send CANCEL to stop.)");
  const e = await entitle(u, f.code);
  if (!e.ok) { await setState(u, "tutor", {}); return reply(u, T.needsPayment(f.name, null)); }

  await reply(u, `Preparing your ${f.name}, one moment...`);
  const out = await ask(generatorSystem(u.level, key), [{ role: "user", content: `Subject and topic: ${text}` }],
    key === "mock" ? 2200 : key === "assignment" ? 1200 : 1000);
  if (e.via === "credit") await rpc("zpay_consume_unit", { p_user: u.id, p_service: f.code }); // charged only after success

  if (key === "revision") {
    await db.from("wa_activity").insert({ user_id: u.id, kind: "revision", subject: text.slice(0, 80) });
    await setState(u, "tutor", {});
    return reply(u, out);
  }
  await setState(u, "answering", { kind: key, subject: text, paper: out, at: new Date().toISOString() });
  return reply(u, out + "\n\n_(Send CANCEL to stop this paper.)_");
}

async function markAnswers(u: Row, text: string, c: Row) {
  const { paper, subject, kind } = u.ctx;
  if (!paper) { await setState(u, "tutor", {}); return tutor(u, text, c); }
  const raw = await ask(markerSystem(u.level), [{ role: "user", content: `QUESTION PAPER:\n${paper}\n\nSTUDENT ANSWERS:\n${text}` }], 1000);
  const j = parseJson<any>(raw);
  if (!j) return reply(u, "Sorry, I could not mark that. Please send your answers again in ONE message, numbered 1., 2., 3.");
  if (j.not_answers) return reply(u, "I am waiting for your answers. Send them in ONE message, numbered 1., 2., 3. ... or send CANCEL to stop.");
  const out = Math.max(1, Number(j.out_of) || 0);
  const score = Math.min(Math.max(0, Number(j.score) || 0), out);
  await db.from("wa_activity").insert({ user_id: u.id, kind, subject: String(subject).slice(0, 80), topic: String(j.topic ?? "").slice(0, 80), score, out_of: out });
  await setState(u, "tutor", {});
  return reply(u, `*Result: ${score}/${out}* (${Math.round((score / out) * 100)}%)\n\n${String(j.feedback ?? "").slice(0, 2500)}\n\nSend MENU for more.`);
}

async function report(u: Row, f: { code: string }) {
  const e = await entitle(u, f.code);
  if (!e.ok) return reply(u, T.needsPayment("performance report", null));
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const { data } = await db.from("wa_activity").select("kind,subject,topic,score,out_of,at").eq("user_id", u.id)
    .gte("at", since).order("at", { ascending: false }).limit(40);
  if ((data ?? []).filter((a: Row) => a.out_of).length < 2) {
    return reply(u, "I need at least 2 marked assignments or mock exams from the last 30 days to build a useful report. Complete some first. You have not been charged.");
  }
  await reply(u, "Preparing your report, one moment...");
  const out = await ask(reportSystem(u.level), [{ role: "user", content: JSON.stringify(data) }], 800);
  if (e.via === "credit") await rpc("zpay_consume_unit", { p_user: u.id, p_service: f.code });
  return reply(u, `📊 *Performance report* (${u.level})\n\n${out}`);
}

/* ------------------------------ shop & payment ------------------------------ */
const per = (s: Row) =>
  s.kind === "access" ? (s.code === "school_term" ? "per student, per term" : `for ${s.duration_days} day${s.duration_days > 1 ? "s" : ""}`) : `per ${s.unit_label}`;

async function showServices(u: Row, c: Row) {
  if (!u.level) { await save(u, { state: "level" }); return reply(u, T.badLevel(c.levels)); }
  const { data } = await db.from("zpay_services").select("code,name,kind,unit_label,max_units,duration_days").eq("enabled", true);
  const svcs = (data ?? []).sort((a: Row, b: Row) => SERVICE_ORDER.indexOf(a.code) - SERVICE_ORDER.indexOf(b.code));
  const quotes = await Promise.all(svcs.map((s: Row) => quote(u, s.code, 1).catch(() => null)));
  const rows = svcs.map((s: Row, i: number) => ({ s, q: quotes[i] })).filter((r: Row) => r.q);
  if (!rows.length) return reply(u, "No paid services are available right now.");
  await setState(u, "shop_service", { services: rows.map((r: Row) => r.s.code) });
  const lines = rows.map((r: Row, i: number) => `${i + 1}. ${r.s.name}: *${T.money(r.q.amount, r.q.currency)}* ${per(r.s)}`);
  return reply(u, `*Services and prices* (${u.level})\n\n${lines.join("\n")}\n\nReply with a number to buy, or *0* for the menu. You always see the full price before you pay.`);
}

async function shopPick(u: Row, t: string) {
  const code = /^\d{1,2}$/.test(t) ? u.ctx.services?.[+t - 1] : null;
  if (!code) return reply(u, "Please reply with a number from the list, or 0 for the menu.");
  const { data: s } = await db.from("zpay_services").select("code,name,unit_label,max_units,kind").eq("code", code).eq("enabled", true).maybeSingle();
  if (!s) return reply(u, "That service is not available right now. Send BUY to see the list again.");
  if (s.max_units === 1) return confirmView(u, code, 1, null);
  await setState(u, "shop_qty", { code, max: s.max_units, label: s.unit_label });
  return reply(u, `How many ${s.unit_label}s do you want? (1 to ${s.max_units})${s.code === "school_term" ? "\nThis is the number of student seats." : ""}`);
}

async function shopQty(u: Row, t: string) {
  const n = /^\d{1,5}$/.test(t) ? +t : 0;
  if (n < 1 || n > u.ctx.max) return reply(u, `Please reply with a number from 1 to ${u.ctx.max}, or 0 for the menu.`);
  return confirmView(u, u.ctx.code, n, null);
}

async function confirmView(u: Row, code: string, units: number, discount: string | null, notice = "") {
  const q = await quote(u, code, units, discount);
  const { data: s } = await db.from("zpay_services").select("name").eq("code", code).single();
  await setState(u, "shop_confirm", { code, units, discount, amount: q.amount });
  return reply(u,
    `${notice}*Order summary*\n${s.name} x ${units} (${u.level})\nPrice each: ${T.money(q.unit_price, q.currency)}\n` +
    (Number(q.discount_pct) > 0 ? `Discount: -${q.discount_pct}%\n` : "") +
    `*Total: ${T.money(q.amount, q.currency)}*\n\nThis price is fixed once you continue.\nReply *YES* to get the EcoCash payment details, type a *discount code* if you have one, or *0* to cancel.`);
}

async function shopConfirm(u: Row, text: string, t: string, c: Row) {
  const { code, units, discount, amount } = u.ctx;
  if (YES.has(t)) {
    const o = await rpc("zpay_create_order", { p_user: u.id, p_service: code, p_units: units, p_level: u.level, p_discount: discount });
    if (Number(o.amount) !== Number(amount)) {   // the owner changed the price while the student was deciding: never charge without consent
      await rpc("zpay_cancel_order", { p_user: u.id, p_order: o.id });
      return confirmView(u, code, units, discount, "The price was just updated. Please check the new total.\n\n");
    }
    await setState(u, "txn_id", { order: { id: o.id, reference: o.reference } });
    return reply(u, T.paymentInstructions(o, c.ecocash_account_name));
  }
  if (t === "no" || t === "n") return showMenu(u, c);
  if (/^[a-z0-9_-]{3,20}$/i.test(text.trim())) {
    try { return await confirmView(u, code, units, text.trim().toUpperCase()); }
    catch (e) {
      if (e instanceof UserError) return reply(u, `${e.message}. Reply YES to continue without a discount, or send another code.`);
      throw e;
    }
  }
  return reply(u, "Reply *YES* to continue, type a discount code, or *0* to cancel.");
}

async function startPaid(u: Row, rest: string) {
  const { data } = await db.from("zpay_orders").select("id,reference").eq("user_id", u.id)
    .in("status", ["awaiting_payment", "expired"]).order("created_at", { ascending: false }).limit(1);
  if (!data?.length) return reply(u, "You have no order waiting for payment. Reply *BUY* to start one.");
  const order = { id: data[0].id, reference: data[0].reference };
  const id = rest.trim();
  if (id && TXN_RE.test(id)) {
    await setState(u, "txn_msisdn", { order, txn: id.toUpperCase() });
    return reply(u, T.askPayerNumber(T.localNumber(u.phone)));
  }
  await setState(u, "txn_id", { order });
  if (id) return reply(u, "That does not look like a transaction ID. Copy it exactly from the EcoCash confirmation SMS and send it here. (Send CANCEL to stop.)");
  return reply(u, `Send the EcoCash *transaction ID* from the confirmation SMS for order *${order.reference}*.`);
}

async function txnId(u: Row, text: string) {
  const id = text.replace(/^paid\s*/i, "").trim();
  if (!TXN_RE.test(id)) return reply(u, "That does not look like a transaction ID. Copy it exactly from the EcoCash confirmation SMS and send it here. (Send CANCEL to stop.)");
  await save(u, { state: "txn_msisdn", ctx: { ...u.ctx, txn: id.toUpperCase() } });
  return reply(u, T.askPayerNumber(T.localNumber(u.phone)));
}

async function txnMsisdn(u: Row, t: string, text: string) {
  if (!u.ctx.order || !u.ctx.txn) { await setState(u, "tutor", {}); return reply(u, "Let us start again. Send *PAID <transaction ID>*."); }
  const payer = t === "same" ? T.localNumber(u.phone) : text.replace(/[^0-9]/g, "");
  try {
    const o = await rpc("zpay_submit_payment", { p_user: u.id, p_order: u.ctx.order.id, p_txn: u.ctx.txn, p_msisdn: payer });
    await setState(u, "tutor", {});
    await reply(u, T.submitted(o.reference));
    await alertAdmins(u, o);
  } catch (e) {
    if (!(e instanceof UserError)) throw e;
    if (/transaction ID/i.test(e.message)) await save(u, { state: "txn_id", ctx: { order: u.ctx.order } });
    return reply(u, e.message);
  }
}

async function cancelFlow(u: Row) {
  if (u.ctx?.order?.id && ["txn_id", "txn_msisdn"].includes(u.state)) {
    await rpc("zpay_cancel_order", { p_user: u.id, p_order: u.ctx.order.id });
  }
  await setState(u, "tutor", {});
  return reply(u, "Cancelled. Send MENU to continue.");
}

async function alertAdmins(u: Row, o: Row) {
  const { data: admins } = await db.from("zpay_wa_admins").select("phone");
  const amount = T.money(o.amount, o.currency);
  const msg = `💰 *Payment to verify*\nRef: ${o.reference}\nService: ${o.service_name} x ${o.units}\nExpected: *${amount}*\nEcoCash ID: ${o.ecocash_txn_id}\nPaid from: ${o.payer_msisdn}\nStudent: ${u.name ?? ""} ${u.phone}\n\n` +
    `Check your EcoCash statement for this amount and ID, then reply:\n*VERIFY ${o.reference}*\nor\n*REJECT ${o.reference} reason*`;
  for (const a of admins ?? []) {
    await notify(a.phone, msg, { name: Deno.env.get("WA_ADMIN_TEMPLATE"), params: [o.reference, amount] });
  }
}

/* ------------------------------ status, receipts, seats ------------------------------ */
async function showStatus(u: Row) {
  const nowIso = new Date().toISOString();
  const { data: ents } = await db.from("zpay_entitlements").select("service_name,expires_at,units,units_remaining")
    .eq("user_id", u.id).eq("status", "active").order("created_at", { ascending: false });
  const live = (ents ?? []).filter((e: Row) => !e.expires_at || e.expires_at > nowIso);
  const { data: seats } = await db.from("zpay_seats").select("zpay_entitlements(service_name,expires_at,status)").eq("user_id", u.id);
  const { data: orders } = await db.from("zpay_orders").select("reference,service_name,amount,currency,status")
    .eq("user_id", u.id).in("status", ["awaiting_payment", "submitted"]).order("created_at", { ascending: false }).limit(5);
  const lines: string[] = [];
  for (const e of live) {
    lines.push(`✅ ${e.service_name}: ${e.expires_at ? `until ${T.when(e.expires_at)}` : `${e.units_remaining} of ${e.units} left`}`);
  }
  for (const s of seats ?? []) {
    const e = Array.isArray(s.zpay_entitlements) ? s.zpay_entitlements[0] : s.zpay_entitlements;
    if (e && e.status === "active" && e.expires_at > nowIso) lines.push(`🏫 School access: until ${T.when(e.expires_at)}`);
  }
  const pend = (orders ?? []).map((o: Row) => `⏳ ${o.reference} ${o.service_name} ${T.money(o.amount, o.currency)}: ${o.status === "submitted" ? "being verified" : "waiting for your payment (send PAID <transaction ID>)"}`);
  return reply(u, `*My access*\n${lines.length ? lines.join("\n") : "No active premium access."}${pend.length ? `\n\n*Payments*\n${pend.join("\n")}` : ""}\n\nSend RECEIPT for your last receipt, BUY to purchase.`);
}

const receiptFrom = (r: Row) => {
  const o = Array.isArray(r.zpay_orders) ? r.zpay_orders[0] : r.zpay_orders;
  return T.receipt({ receipt_no: r.receipt_no, issued_at: r.issued_at, service: o.service_name, units: o.units, level: o.form_level,
    amount: o.amount, currency: o.currency, pay_to: o.pay_to, txn: o.ecocash_txn_id, reference: o.reference });
};
const RECEIPT_COLS = "receipt_no,issued_at,zpay_orders(service_name,units,form_level,amount,currency,pay_to,ecocash_txn_id,reference)";

async function sendReceipt(u: Row) {
  const { data } = await db.from("zpay_receipts").select(RECEIPT_COLS).eq("user_id", u.id).order("issued_at", { ascending: false }).limit(1);
  if (!data?.length) return reply(u, "No receipts yet. A receipt is issued after your payment is verified.");
  return reply(u, receiptFrom(data[0]));
}

async function addSeat(u: Row, arg: string) {
  const r = await rpc("zpay_add_seat", { p_user: u.id, p_phone: arg });
  await reply(u, `✅ Added ${arg}. Seats used: ${r.used} of ${r.total}. Their access ends ${T.when(r.expires_at)}.`);
  await notify(r.phone, `You now have ZIMSEC AI Teacher premium access through your school until ${T.when(r.expires_at)}. Send MENU to start learning.`,
    { name: Deno.env.get("WA_SEAT_TEMPLATE"), params: [T.when(r.expires_at)] });
}

/* ------------------------------ owner / admin commands (WhatsApp) ------------------------------ */
const adminHelp = "*Admin commands*\nPENDING - payments waiting for you\nVERIFY <ref> - confirm a payment\nREJECT <ref> <reason> - reject it\nSUMMARY - revenue summary\n\nFull financial controls are on the web dashboard.";

async function isAdmin(phone: string) {
  const { data } = await db.from("zpay_wa_admins").select("phone").eq("phone", phone).maybeSingle();
  return !!data;
}

async function adminCommand(u: Row, text: string, t: string, c: Row): Promise<boolean> {
  if (t === "admin") { await reply(u, adminHelp); return true; }

  if (t === "pending") {
    const { data } = await db.from("zpay_orders").select("reference,service_name,units,amount,currency,ecocash_txn_id,payer_msisdn,submitted_at,wa_users(phone)")
      .eq("status", "submitted").order("submitted_at").limit(10);
    if (!data?.length) { await reply(u, "No payments are waiting for verification. ✅"); return true; }
    await reply(u, data.map((o: Row) => {
      const stu = Array.isArray(o.wa_users) ? o.wa_users[0] : o.wa_users;
      return `*${o.reference}*  ${T.money(o.amount, o.currency)}\n${o.service_name} x ${o.units}\nEcoCash ID: ${o.ecocash_txn_id}\nPaid from: ${o.payer_msisdn}\nStudent: ${stu?.phone}\nSubmitted: ${T.when(o.submitted_at)}`;
    }).join("\n\n") + "\n\nReply VERIFY <ref> or REJECT <ref> reason.");
    return true;
  }

  if (t === "summary") {
    const d = await rpc("zpay_wa_summary", { p_admin_phone: u.phone });
    const m = (n: number) => T.money(n, d.currency);
    await reply(u, `📊 *Revenue summary*\nToday: ${m(d.today)}\nThis week: ${m(d.week)}\nThis month: ${m(d.month)}\nTotal: ${m(d.total_revenue)}\nSubscriptions: ${m(d.subscription_revenue)}\n\nPaying students: ${d.paying_students}\nSuccessful payments: ${d.successful}\nPending verification: ${d.pending_verification}\nAwaiting payment: ${d.awaiting_payment}\nFailed or expired: ${d.failed}`);
    return true;
  }

  const m = text.match(/^(verify|reject)\s+(zat-[a-z0-9]{8})\s*(.*)$/i);
  if (!m) return false;
  const approve = m[1].toLowerCase() === "verify", ref = m[2].toUpperCase(), note = m[3].trim() || null;
  const { data: before } = await db.from("zpay_orders").select("status").eq("reference", ref).maybeSingle();
  if (!before) { await reply(u, `No order with reference ${ref}.`); return true; }
  const o = await rpc("zpay_wa_verify", { p_admin_phone: u.phone, p_reference: ref, p_approve: approve, p_note: note });
  if (approve && before.status === "verified") { await reply(u, `${ref} was already verified. Nothing changed.`); return true; }

  const { data: stu } = await db.from("wa_users").select("phone").eq("id", o.user_id).single();
  if (approve) {
    const { data: rc } = await db.from("zpay_receipts").select(RECEIPT_COLS).eq("order_id", o.id).limit(1);
    const { data: ent } = await db.from("zpay_entitlements").select("expires_at,units_remaining").eq("order_id", o.id).limit(1);
    const e = ent?.[0];
    await reply(u, `✅ ${ref} verified. The student has been told.`);
    await notify(stu.phone,
      `✅ *Payment verified*\n${o.service_name} x ${o.units} is now active${e?.expires_at ? ` until ${T.when(e.expires_at)}` : ""}.\n\n${rc?.length ? receiptFrom(rc[0]) : ""}\n\nSend MENU to start learning.`,
      { name: Deno.env.get("WA_VERIFIED_TEMPLATE"), params: [o.service_name, ref] });
  } else {
    await reply(u, `❌ ${ref} rejected. The student has been told.`);
    await notify(stu.phone,
      `We could not verify your payment for *${ref}*.${note ? ` Reason: ${note}.` : ""} If you did pay, please contact support${c.support_contact ? ` on ${c.support_contact}` : ""} and quote this reference.`,
      { name: Deno.env.get("WA_REJECTED_TEMPLATE"), params: [ref] });
  }
  return true;
}

/* ------------------------------ router ------------------------------ */
async function route(u: Row, text: string) {
  const c = await cfg();
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();

  if (await isAdmin(u.phone) && await adminCommand(u, text, t, c)) return;

  if (u.state === "new") { await save(u, { state: "level", ctx: {} }); return reply(u, T.welcome(c.levels)); }
  if (u.state === "level") return chooseLevel(u, t, c);

  // commands that work in any state
  if (["menu", "hi", "hello", "hey", "start", "0", "mhoro", "hie"].includes(t)) return showMenu(u, c);
  if (t === "help") return reply(u, T.help);
  if (t === "cancel") return cancelFlow(u);
  if (t === "buy" || t === "prices" || t === "services") return showServices(u, c);
  if (t === "status" || t === "my access") return showStatus(u);
  if (t === "receipt") return sendReceipt(u);
  if (t === "level") { await save(u, { state: "level", ctx: {} }); return reply(u, T.badLevel(c.levels)); }
  if (t === "stop") { await save(u, { notify: false }); return reply(u, "Reminders are off. Send START REMINDERS to turn them on again."); }
  if (t === "start reminders") { await save(u, { notify: true }); return reply(u, "Reminders are on."); }
  if (t === "delete") { await setState(u, "confirm_delete", {}); return reply(u, "This erases your name, study history and chat memory. Payment records must be kept for accounting. Reply *YES* to confirm, or CANCEL."); }
  const paid = text.match(/^paid\b\s*(.*)$/i);
  if (paid) return startPaid(u, paid[1]);
  const add = text.match(/^add\s+(\+?[0-9 ]{9,16})$/i);   // phone numbers only, so "add 5 and 3" still reaches the tutor
  if (add) return addSeat(u, add[1]);

  if (u.state === "tutor" && /^[1-7]$/.test(t)) return menuChoice(u, +t, c);

  switch (u.state) {
    case "shop_service": return shopPick(u, t);
    case "shop_qty": return shopQty(u, t);
    case "shop_confirm": return shopConfirm(u, text, t, c);
    case "txn_id": return txnId(u, text);
    case "txn_msisdn": return txnMsisdn(u, t, text);
    case "gen": return generate(u, text);
    case "answering": return markAnswers(u, text, c);
    case "confirm_delete":
      if (YES.has(t)) {
        await db.from("wa_activity").delete().eq("user_id", u.id);
        await save(u, { name: null, level: null, history: [], ctx: {}, state: "new", session_until: null });
        return reply(u, "Done. Your study data has been erased. Send any message to start again.");
      }
      return reply(u, "Send YES to erase your data, or CANCEL.");
  }
  return tutor(u, text, c);
}

/* ------------------------------ webhook plumbing ------------------------------ */
async function handle(m: Row, profileName: string | null) {
  const phone: string = m.from;
  if (!/^\d{9,15}$/.test(phone ?? "")) return;
  const { error: dup } = await db.from("wa_seen").insert({ msg_id: m.id });
  if (dup?.code === "23505") return; // Meta retried a message we already handled

  let { data: u } = await db.from("wa_users").select("*").eq("phone", phone).maybeSingle();
  if (!u) {
    await db.from("wa_users").upsert({ phone, name: profileName }, { onConflict: "phone", ignoreDuplicates: true });
    ({ data: u } = await db.from("wa_users").select("*").eq("phone", phone).single());
  }
  if (!u || u.blocked) return;
  const seen: Row = { last_seen_at: new Date().toISOString() };
  if (!u.name && profileName) seen.name = profileName;
  await save(u, seen);

  if (m.type !== "text") {
    if (["image", "audio", "voice", "video", "document", "sticker"].includes(m.type)) await reply(u, T.textOnly);
    return;
  }
  const text = String(m.text?.body ?? "").trim().slice(0, 2000);
  if (!text) return;
  try {
    await route(u, text);
  } catch (e) {
    if (e instanceof UserError) { await reply(u, e.message); return; }
    console.error("route error", e);
    await reply(u, T.oops);
  }
}

async function processBody(body: Row) {
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const mine = Deno.env.get("WA_PHONE_NUMBER_ID");
      if (mine && v.metadata?.phone_number_id && v.metadata.phone_number_id !== mine) continue;
      const names: Record<string, string> = {};
      for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name ?? null;
      for (const m of v.messages ?? []) {
        try { await handle(m, names[m.from] ?? null); } catch (e) { console.error("handle error", e); }
      }
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    const token = Deno.env.get("WA_VERIFY_TOKEN");
    if (token && q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === token) return new Response(q.get("hub.challenge") ?? "", { status: 200 });
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), Deno.env.get("WA_APP_SECRET") ?? ""))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let body: Row;
  try { body = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }

  // Answer Meta immediately; do the work in the background (duplicates are filtered by wa_seen).
  const work = processBody(body);
  // @ts-ignore EdgeRuntime exists on Supabase Edge Functions
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return new Response("ok", { status: 200 });
});
