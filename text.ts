// All student-facing wording lives here so the owner can edit it without touching logic.

export const money = (n: number | string, cur = "USD") =>
  cur === "USD" ? `US$${Number(n).toFixed(2)}` : `${cur} ${Number(n).toFixed(2)}`;

export const when = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-GB", { timeZone: "Africa/Harare", dateStyle: "medium", timeStyle: "short" }) : "-";

export const harareDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Africa/Harare" });

/** 263771234567 -> 0771234567 */
export const localNumber = (wa: string) => (wa.startsWith("263") ? "0" + wa.slice(3) : wa);

export const welcome = (levels: string[]) =>
  `*Welcome to ZIMSEC AI Teacher* 🎓\nYour study helper for ZIMSEC O-Level and A-Level.\n\n` +
  `By continuing you agree that we store your number, level and study activity to run this service. Reply *DELETE* any time to erase your study data. We will *never* ask for your EcoCash PIN, password or OTP.\n\n` +
  `Which level are you in? Reply with a number:\n${levels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

export const badLevel = (levels: string[]) =>
  `Please reply with a number from 1 to ${levels.length}:\n${levels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;

export const menu = (level: string, freeLeft: number | null) =>
  `*ZIMSEC AI Teacher* 🎓  (${level})\n\n` +
  `Just type your question, for example:\n_Maths: how do I solve x^2 - 5x + 6 = 0?_\n\n` +
  `Or choose:\n1. Ask the tutor\n2. Practice assignment\n3. Mock exam\n4. Revision notes\n5. My performance report\n6. Buy or renew\n7. My access and receipts\n\n` +
  (freeLeft === null ? "Premium access is active. ✅" : `Free questions left today: ${freeLeft}`) +
  `\nSend *HELP* for all commands.`;

export const help =
  `*Commands*\nMENU - main menu\nBUY - prices and payment\nSTATUS - my access and payments\nRECEIPT - my last receipt\n` +
  `PAID <transaction ID> - send your EcoCash payment details\nLEVEL - change my level\nCANCEL - stop what I am doing\n` +
  `ADD <number> - add a student to my school subscription\nSTOP - stop reminders\nDELETE - erase my study data`;

export const textOnly = "Please send your message as text. Photos, voice notes and files are not supported yet.";
export const oops = "Sorry, something went wrong on our side. Please try again in a moment.";

export const paywallTutor = (freeTotal: number) =>
  `You have used your ${freeTotal} free questions for today. They reset at midnight (Zimbabwe time).\n\n` +
  `To keep learning now, reply *BUY* and choose Premium AI Tutoring or a Daily, Weekly or Monthly access pack.`;

export const dailyCap = "You have reached today's fair-use limit. Please continue tomorrow.";

export const feature: Record<string, { code: string; name: string; ask?: string }> = {
  assignment: { code: "extra_assignment", name: "practice assignment", ask: "Which *subject and topic*?\nExample: _Maths - quadratic equations_" },
  mock: { code: "mock_exam", name: "mock exam", ask: "Which *subject and topic* should the mock exam cover?\nExample: _Biology - nutrition and digestion_" },
  revision: { code: "advanced_revision", name: "revision notes", ask: "Which *subject and topic* do you want revision notes for?" },
  report: { code: "performance_report", name: "performance report" },
};

export const needsPayment = (name: string, price: string | null) =>
  `The *${name}* is a premium service${price ? ` (from ${price})` : ""}.\nReply *BUY* to purchase it and pay with EcoCash.`;

export const unavailable = (name: string) => `The ${name} is not available right now. Please try again later.`;

export const paymentInstructions = (o: { amount: number; currency: string; pay_to: string; reference: string; expires_at: string }, accountName: string) =>
  `*Pay with EcoCash* 💳\n\nAmount: *${money(o.amount, o.currency)}*\nSend to: *${o.pay_to}*${accountName ? ` (${accountName})` : ""}\nReference: *${o.reference}*\n\n` +
  `1. Open your EcoCash menu or app and choose *Send Money*.\n2. Send exactly *${money(o.amount, o.currency)}* to *${o.pay_to}*.\n` +
  `3. If asked for a reason, type ${o.reference}.\n4. When the EcoCash confirmation SMS arrives, copy the *transaction ID*.\n5. Reply here with it, or send: *PAID <transaction ID>*\n\n` +
  `⚠️ Never share your EcoCash PIN, password or OTP, with us or anyone. We will never ask for them.\n` +
  `Your service starts only after we verify the payment. This order is valid until ${when(o.expires_at)}. Send *CANCEL* to cancel it.`;

export const askPayerNumber = (own: string) =>
  `Which EcoCash number did you pay from?\nReply with the number (for example 0771234567), or *SAME* if you paid from this WhatsApp number (${own}).`;

export const submitted = (ref: string) =>
  `✅ Thank you. We received your payment details for *${ref}* and are verifying the payment. ` +
  `You will get a WhatsApp message with your receipt as soon as it is confirmed. Your service is activated only after verification.`;

export const receipt = (r: {
  receipt_no: string; issued_at: string; service: string; units: number; level: string | null; amount: number; currency: string;
  pay_to: string; txn: string; reference: string;
}) =>
  `🧾 *PAYMENT RECEIPT*\nZIMSEC AI Teacher\n\nReceipt no: ${r.receipt_no}\nDate: ${when(r.issued_at)}\nService: ${r.service} x ${r.units}${r.level ? ` (${r.level})` : ""}\n` +
  `Amount paid: *${money(r.amount, r.currency)}*\nMethod: EcoCash to ${r.pay_to}\nEcoCash transaction ID: ${r.txn}\nOrder reference: ${r.reference}`;
