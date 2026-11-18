// Test double for @supabase/supabase-js that talks to a REAL local Postgres through psql, as the
// service_role. It lets the bot run unchanged against the real schema, constraints and SQL functions.
// Only what the bot uses is implemented (select/insert/update/delete/upsert, filters, one-level embeds, rpc).
import { execFileSync } from "node:child_process";

function psql(sql) {
  const args = ["-h", process.env.PGHOST, "-p", process.env.PGPORT, "-U", "postgres", "-d", process.env.PGDATABASE,
    "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", "set role service_role", "-c", sql];
  try {
    return { out: execFileSync("psql", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    const m = msg.match(/ERROR:\s+(\w{5}):\s+([^\n]*)/);
    return { error: { code: m ? m[1] : "XX000", message: m ? m[2] : msg } };
  }
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const lit = (v, textArray = false) =>
  v === null || v === undefined ? "null"
  : typeof v === "number" || typeof v === "boolean" ? String(v)
  : Array.isArray(v) ? (textArray ? `array[${v.map((x) => lit(x)).join(",")}]::text[]` : `${q(JSON.stringify(v))}::jsonb`)
  : typeof v === "object" ? `${q(JSON.stringify(v))}::jsonb`
  : q(v);

const FK = { wa_users: "user_id", zpay_services: "service_id", zpay_orders: "order_id", zpay_entitlements: "entitlement_id" };

function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Query {
  constructor(table) { this.t = table; this.op = "select"; this.cols = "*"; this.f = []; this.ord = []; this.lim = null; this.mode = "many"; this.payload = null; this.opts = {}; }
  select(c = "*") { this.cols = c; return this; }
  insert(p, o) { this.op = "insert"; this.payload = p; this.opts = o || {}; return this; }
  upsert(p, o) { this.op = "upsert"; this.payload = p; this.opts = o || {}; return this; }
  update(p) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.f.push(`b.${c} = ${lit(v)}`); return this; }
  in(c, vs) { this.f.push(`b.${c} in (${vs.map((x) => lit(x)).join(",")})`); return this; }
  gt(c, v) { this.f.push(`b.${c} > ${lit(v)}`); return this; }
  gte(c, v) { this.f.push(`b.${c} >= ${lit(v)}`); return this; }
  lt(c, v) { this.f.push(`b.${c} < ${lit(v)}`); return this; }
  is(c, v) { this.f.push(`b.${c} is ${v === null ? "null" : lit(v)}`); return this; }
  order(c, { ascending = true } = {}) { this.ord.push(`b.${c} ${ascending ? "asc" : "desc"}`); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybe"; return this; }
  then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }

  run() {
    const where = this.f.length ? ` where ${this.f.join(" and ")}` : "";
    if (this.op === "insert" || this.op === "upsert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload];
      const cols = Object.keys(rows[0]);
      let sql = `insert into ${this.t} (${cols.join(",")}) values ${rows.map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`).join(",")}`;
      if (this.op === "upsert") sql += this.opts.ignoreDuplicates ? ` on conflict (${this.opts.onConflict}) do nothing` : "";
      const r = psql(sql);
      return { data: null, error: r.error ?? null };
    }
    if (this.op === "update") {
      const set = Object.entries(this.payload).map(([k, v]) => `${k} = ${lit(v)}`).join(", ");
      const r = psql(`update ${this.t} as b set ${set}${where}`);
      return { data: null, error: r.error ?? null };
    }
    if (this.op === "delete") {
      const r = psql(`delete from ${this.t} as b${where}`);
      return { data: null, error: r.error ?? null };
    }
    const exprs = splitTop(this.cols).map((c) => {
      const m = c.match(/^(\w+)\((.*)\)$/s);
      if (!m) return c === "*" ? "b.*" : `b.${c}`;
      const [, rel, inner] = m;
      const ecols = splitTop(inner).map((x) => (x === "*" ? "r0.*" : `r0.${x}`)).join(", ");
      return `(select to_jsonb(r) from (select ${ecols} from ${rel} r0 where r0.id = b.${FK[rel]}) r) as ${rel}`;
    });
    const order = this.ord.length ? ` order by ${this.ord.join(", ")}` : "";
    const limit = this.lim != null ? ` limit ${this.lim}` : "";
    const r = psql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)::text from (select ${exprs.join(", ")} from ${this.t} b${where}${order}${limit}) t`);
    if (r.error) return { data: null, error: r.error };
    const rows = JSON.parse(r.out);
    if (this.mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: "expected one row" } };
    if (this.mode === "maybe") return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }
}

const meta = {};
function rpc(name, args = {}) {
  if (!meta[name]) {
    const r = psql(`select proretset, (select typname from pg_type where oid = prorettype) from pg_proc where proname = ${q(name)} limit 1`);
    if (r.error || !r.out) return Promise.resolve({ data: null, error: { code: "42883", message: `function ${name} does not exist` } });
    const [set, type] = r.out.split("|");
    meta[name] = { set: set === "t", type };
  }
  const { set, type } = meta[name];
  const call = `${name}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(v, true)}`).join(", ")})`;
  const sql = set ? `select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)::text from ${call} f`
    : type === "void" ? `select ${call}` : `select to_jsonb(${call})::text`;
  const r = psql(sql);
  if (r.error) return Promise.resolve({ data: null, error: r.error });
  return Promise.resolve({ data: type === "void" || r.out === "" ? null : JSON.parse(r.out), error: null });
}

export function createClient() {
  return { from: (t) => new Query(t), rpc };
}
