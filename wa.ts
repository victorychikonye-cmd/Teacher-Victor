// WhatsApp Cloud API helpers (Meta). Secrets: WA_ACCESS_TOKEN, WA_PHONE_NUMBER_ID, WA_APP_SECRET.
const GRAPH = "https://graph.facebook.com/v21.0";

/** Split long text on paragraph/line boundaries (WhatsApp limit is 4096 chars). */
export function chunk(text: string, max = 3800): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function post(payload: Record<string, unknown>): Promise<boolean> {
  const id = Deno.env.get("WA_PHONE_NUMBER_ID"), token = Deno.env.get("WA_ACCESS_TOKEN");
  if (!id || !token) { console.error("WhatsApp credentials are not configured"); return false; }
  try {
    const r = await fetch(`${GRAPH}/${id}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    if (!r.ok) console.error("WhatsApp send failed", r.status, (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.error("WhatsApp send error", String(e));
    return false;
  }
}

/** Send a text message. Returns true only if every part was accepted. */
export async function sendText(to: string, body: string): Promise<boolean> {
  let ok = true;
  for (const part of chunk(body)) {
    ok = (await post({ to, type: "text", text: { body: part, preview_url: false } })) && ok;
  }
  return ok;
}

export function sendTemplate(to: string, name: string, params: string[], lang = "en"): Promise<boolean> {
  return post({
    to, type: "template",
    template: {
      name, language: { code: lang },
      components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] : [],
    },
  });
}

/**
 * Proactive message (payment alerts, expiry reminders). WhatsApp only allows free text within 24h of the
 * person's last message; outside that window an approved template is required, so fall back to it.
 */
export async function notify(to: string, text: string, tpl?: { name?: string | null; params: string[] }) {
  if (await sendText(to, text)) return true;
  if (tpl?.name) return await sendTemplate(to, tpl.name, tpl.params);
  return false;
}

/** Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body with the app secret). */
export async function verifySignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header || !header.startsWith("sha256=") || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
