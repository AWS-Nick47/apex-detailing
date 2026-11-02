// Owner dashboard (/admin) for Nick: schedule + blockouts, jobs, customers, members, money, settings.
// Only reachable through Cloudflare Access; every request is also checked here (fail closed).
import { RULES, dayInfo, nyToUtc, utcToNy, addDays, parseDay, sunsetMin, inWinter } from "./sched.js";
import { PRICING, TAX } from "./pricing.js";
import { MEM, planLabel } from "./membership.js";
import { ownerApi, jobRow, withThumbs, moneyExtras } from "./owner.js";
import { uploadPhoto, storageOn } from "./photos.js";
import { currentSettings } from "./settings.js";

const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), x => x.toString(16).padStart(2, "0")).join("");
const todayKey = () => utcToNy(Date.now()).key;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- NJ sales tax owed, by quarter ----------
// Tax is counted when the money comes in (detail paid, membership charge or fee). Amounts are cents.
// NJ ST-50 return + payment is due the 20th of the month after each quarter (monthly payments only after $30,000/yr of tax).
const quarterOf = key => key.slice(0, 4) + "-Q" + (Math.floor((+key.slice(5, 7) - 1) / 3) + 1);
function quarterInfo(k) {
  const y = +k.slice(0, 4), q = +k.slice(6);
  return { key: k, label: ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][q - 1] + " " + y, due: q === 4 ? (y + 1) + "-01-20" : y + "-" + String(q * 3 + 1).padStart(2, "0") + "-20" };
}
async function taxQuarters(env) {
  // a detail that was paid and then cancelled is refunded in Square, so it isn't a taxable sale (review after the audit)
  const det = (await env.DB.prepare("SELECT paid_at t, final_cents a, tax_cents x FROM bookings WHERE paid_at IS NOT NULL AND kind != 'member' AND final_cents IS NOT NULL AND status != 'cancelled'").all()).results || [];
  const mem = (await env.DB.prepare("SELECT created_at t, amount_cents a, tax_cents x FROM membership_charges WHERE status = 'paid' AND amount_cents > 0").all()).results || [];
  const filedRow = await env.DB.prepare("SELECT v FROM meta WHERE k = 'tax_filed'").first(), filed = filedRow ? JSON.parse(filedRow.v) : {};
  const cur = quarterOf(todayKey()), Q = {};
  const get = k => Q[k] || (Q[k] = Object.assign(quarterInfo(k), { sales: 0, taxed: 0, tax: 0, payments: 0 }));
  get(cur);
  for (const r of det.concat(mem)) { const x = get(quarterOf(utcToNy(r.t).key)); x.sales += r.a || 0; x.tax += r.x || 0; if (r.x) x.taxed += r.a || 0; x.payments++; }
  return Object.values(Q).sort((a, b) => b.key.localeCompare(a.key)).map(q => ({ key: q.key, label: q.label, due: q.due, current: q.key === cur, sales: q.sales / 100, taxedSales: q.taxed / 100, tax: q.tax / 100, payments: q.payments, filed: filed[q.key] || null }));
}

// ---------- Cloudflare Access check ----------
// Access puts a signed token (JWT) on every request it lets through. We verify the signature with Access's public
// keys, the audience (which Access app), and expiry. ADMIN_EMAILS (optional) narrows it to specific people.
let certCache = { at: 0, keys: [] };
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64uJson = s => JSON.parse(new TextDecoder().decode(b64u(s)));

export async function accessUser(req, env, fetchCerts) {
  const host = new URL(req.url).hostname;
  if (env.ADMIN_DEV === "1" && (host === "localhost" || host === "127.0.0.1")) return { email: "dev@localhost" };   // local testing only (.dev.vars)
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const tok = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!tok) return null;
  const parts = tok.split("."); if (parts.length !== 3) return null;
  let head, body; try { head = b64uJson(parts[0]); body = b64uJson(parts[1]); } catch (e) { return null; }
  if (head.alg !== "RS256") return null;
  const known = certCache.keys.find(k => k.kid === head.kid);
  if (!known && certCache.keys.length && Date.now() - certCache.at < 60e3) return null;   // unknown key id: refetch at most once a minute
  if (!certCache.keys.length || Date.now() - certCache.at > 3600e3 || !known) {
    const r = await (fetchCerts || fetch)("https://" + env.ACCESS_TEAM + "/cdn-cgi/access/certs");
    const j = await r.json(); certCache = { at: Date.now(), keys: j.keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!ok) return null;
  const now = Date.now() / 1000;
  if (!body.exp || body.exp < now || (body.nbf && body.nbf > now + 60)) return null;
  const auds = String(env.ACCESS_AUD).split(",").map(s => s.trim()).filter(Boolean), tokAud = [].concat(body.aud || []);
  if (!tokAud.some(a => auds.includes(a))) return null;
  if (body.iss !== "https://" + env.ACCESS_TEAM) return null;
  const email = String(body.email || "").toLowerCase();
  if (env.ADMIN_EMAILS) { const allow = String(env.ADMIN_EMAILS).toLowerCase().split(",").map(s => s.trim()); if (!allow.includes(email)) return null; }
  return { email };
}

// ---------- blockouts ----------
const weekday = key => { const { y, m, d } = parseDay(key); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
function appliesOn(bo, key) {
  if (bo.repeat === "once") return bo.day === key;
  if (bo.from_day && key < bo.from_day) return false;
  if (bo.until_day && key > bo.until_day) return false;
  if (JSON.parse(bo.skip_days || "[]").includes(key)) return false;
  return String(bo.weekdays || "").split(",").map(Number).includes(weekday(key));
}
async function allBlockouts(env) { return (await env.DB.prepare("SELECT * FROM blockouts ORDER BY created_at").all()).results || []; }

// Blockouts as busy rows (same shape as the calendar's busy table) so availability treats them like calendar events.
export async function blockoutBusy(env, fromMs, toMs, list) {
  list = list || await allBlockouts(env); if (!list.length) return [];
  const out = []; let k = utcToNy(fromMs).key; const last = utcToNy(toMs).key;
  for (let guard = 0; k <= last && guard < 400; guard++, k = addDays(k, 1)) {
    for (const bo of list) {
      if (!appliesOn(bo, k)) continue;
      const allDay = bo.start_min == null;
      out.push({ start_utc: nyToUtc(k, allDay ? 0 : bo.start_min), end_utc: allDay ? nyToUtc(addDays(k, 1), 0) : nyToUtc(k, bo.end_min), all_day: allDay ? 1 : 0, kind: "blocked", id: bo.id, title: bo.title, repeat: bo.repeat });
    }
  }
  return out;
}

function hm(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "")); if (!m) return null; const v = +m[1] * 60 + +m[2]; return v >= 0 && v <= 1440 ? v : null; }
function readBlockout(b) {
  const repeat = b.repeat === "weekly" ? "weekly" : "once", allDay = !!b.allDay;
  const f = { title: String(b.title || "").trim().slice(0, 60) || "Blocked", repeat, start_min: allDay ? null : hm(b.start), end_min: allDay ? null : hm(b.end) };
  if (!allDay && (f.start_min == null || f.end_min == null || f.end_min <= f.start_min)) throw new Error("Pick a start and end time (end after start).");
  if (repeat === "once") { if (!DAY_RE.test(b.day || "")) throw new Error("Pick a date."); f.day = b.day; }
  else {
    const wd = [].concat(b.weekdays || []).map(Number).filter(n => n >= 0 && n <= 6);
    if (!wd.length) throw new Error("Pick at least one day of the week.");
    f.weekdays = [...new Set(wd)].sort().join(",");
    f.from_day = DAY_RE.test(b.from_day || "") ? b.from_day : todayKey();
    f.until_day = DAY_RE.test(b.until_day || "") ? b.until_day : null;
    if (f.until_day && f.until_day < f.from_day) throw new Error("The end date is before the start date.");
  }
  return f;
}

// ---------- API ----------
export async function adminApi(req, env, url, H, who) {
  const p = url.pathname.replace(/^\/api\/admin/, ""), M = req.method;
  if (p === "/photos" && M === "POST") return uploadPhoto(req, env);   // multipart, read before any JSON
  const body = M === "POST" ? await req.json().catch(() => ({})) : {};
  const email = who && who.email;
  const owned = await ownerApi(req, env, url, H, p, M, body, email); if (owned) return owned;

  if (p === "/home" && M === "GET") {
    const now = Date.now(), today = todayKey();
    const next = (await env.DB.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND ((end_utc > ? AND completed_at IS NULL) OR (day = ? AND started_at IS NOT NULL AND completed_at IS NULL)) ORDER BY start_utc LIMIT 5").bind(now, today).all()).results || [];
    const unacked = (await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'confirmed' AND acked_at IS NULL AND end_utc > ?").bind(now).first()).n;
    const unpaid = (await env.DB.prepare("SELECT id, ack_token, pkg, kind, name, day, quote FROM bookings WHERE status = 'confirmed' AND kind != 'member' AND paid_at IS NULL AND end_utc < ? ORDER BY start_utc DESC LIMIT 10").bind(now).all()).results || [];
    const pastDue = (await env.DB.prepare("SELECT COUNT(*) n FROM memberships WHERE status = 'past_due'").first()).n;
    const month = today.slice(0, 7), m0 = nyToUtc(month + "-01", 0);
    const det = await env.DB.prepare("SELECT COALESCE(SUM(final_cents),0) a, COALESCE(SUM(tip_cents),0) t, COALESCE(SUM(tax_cents),0) x, COUNT(*) n FROM bookings WHERE paid_at >= ? AND kind != 'member' AND status != 'cancelled'").bind(m0).first();
    const mem = await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'monthly' THEN amount_cents ELSE 0 END),0) a, COALESCE(SUM(tax_cents),0) x FROM membership_charges WHERE status = 'paid' AND created_at >= ?").bind(m0).first();   // monthly charges only; cancel fees are in Money (audit IA-021e)
    const tq = (await taxQuarters(env)).find(q => q.current);
    const active = (await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(monthly_cents),0) mrr FROM memberships WHERE status IN ('active','ending','past_due')").first());
    const sync = await env.DB.prepare("SELECT v FROM meta WHERE k = 'synced'").first();
    return json({ next: await withThumbs(env, next.map(b => jobRow(b, H))), storage: storageOn(env), unacked, unpaid: unpaid.map(b => jobRow(b, H)), pastDue, month: { details: det.a / 100, tips: det.t / 100, jobs: det.n, members: mem.a / 100, tax: (det.x + mem.x) / 100 }, taxQuarter: tq,
      members: { count: active.n, monthly: active.mrr / 100 }, sync: sync ? JSON.parse(sync.v) : null });
  }

  if (p === "/week" && M === "GET") {
    const from = DAY_RE.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : todayKey();
    const n = Math.max(1, Math.min(14, +url.searchParams.get("n") || 7));
    const d0 = nyToUtc(from, 0) - 864e5, d1 = nyToUtc(addDays(from, n), 0) + 864e5;
    const busy = (await env.DB.prepare("SELECT start_utc, end_utc, all_day, kind FROM busy WHERE end_utc > ? AND start_utc < ?").bind(d0, d1).all()).results || [];
    const blocks = await blockoutBusy(env, d0, d1);
    const jobs = (await env.DB.prepare("SELECT id, ack_token, token, kind, pkg, size, start_utc, end_utc, day, name, town, car, color, status, acked_at, paid_at, completed_at FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND start_utc < ?").bind(d0, d1).all()).results || [];
    const days = [];
    for (let i = 0; i < n; i++) {
      const k = addDays(from, i), s0 = nyToUtc(k, 0), s1 = nyToUtc(addDays(k, 1), 0);
      const info = dayInfo(k, busy.concat(blocks), jobs);
      const wall = ms => ms <= s0 ? 0 : ms >= s1 ? 1440 : utcToNy(ms).min, clip = (a, b) => [wall(a), wall(b)];   // wall-clock minutes (DST-safe)
      const items = [];
      for (const r of busy) { if (r.end_utc <= s0 || r.start_utc >= s1) continue; const [a, b] = clip(r.start_utc, r.end_utc); items.push({ type: r.kind === "job" ? "caljob" : r.kind === "blocked" ? "calblock" : "event", start: r.all_day ? null : a, end: r.all_day ? null : b, allDay: !!r.all_day }); }
      for (const r of blocks) { if (r.end_utc <= s0 || r.start_utc >= s1) continue; const [a, b] = clip(r.start_utc, r.end_utc); items.push({ type: "block", id: r.id, title: r.title, repeat: r.repeat, start: r.all_day ? null : a, end: r.all_day ? null : b, allDay: !!r.all_day }); }
      for (const b of jobs) { if (b.day !== k) continue; const [a, e] = clip(b.start_utc, b.end_utc); items.push(Object.assign({ type: "job", start: a, end: e }, jobRow(b, H))); }
      items.sort((x, y) => (x.allDay ? -1 : x.start) - (y.allDay ? -1 : y.start));
      // free windows: gaps between blocked time (incl. the 1-hr buffers) inside the working day
      const maxJ = info.off ? RULES.maxJobsDayOff : RULES.maxJobs, free = [];
      if (info.j < maxJ) { let t = RULES.startMin; for (const [a, b] of info.b) { if (b <= t) continue; if (a > t) free.push([t, Math.min(a, info.end)]); t = Math.max(t, b); if (t >= info.end) break; } if (t < info.end) free.push([t, info.end]); }
      const { y, m, d } = parseDay(k);
      days.push({ day: k, items, free: free.filter(f => f[1] - f[0] >= 60), jobs: info.j, maxJobs: maxJ, off: info.off, end: info.end, sunset: sunsetMin(k), winter: inWinter(y, m, d), past: k < todayKey() });
    }
    return json({ from, days, rules: { startMin: RULES.startMin, gapMin: RULES.gapMin, baseMin: RULES.baseMin } });
  }

  if (p === "/blockouts" && M === "GET") {
    const today = todayKey();
    const list = (await allBlockouts(env)).filter(b => b.repeat === "weekly" ? !b.until_day || b.until_day >= today : b.day >= today);
    return json({ blockouts: list.map(b => Object.assign({}, b, { skip_days: JSON.parse(b.skip_days || "[]") })) });
  }
  if (p === "/blockouts" && M === "POST") {
    let f; try { f = readBlockout(body); } catch (e) { return json({ error: e.message }, 400); }
    const id = rid();
    await env.DB.prepare("INSERT INTO blockouts (id, title, repeat, day, weekdays, from_day, until_day, start_min, end_min, skip_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)")
      .bind(id, f.title, f.repeat, f.day || null, f.weekdays || null, f.from_day || null, f.until_day || null, f.start_min, f.end_min, Date.now()).run();
    return json({ ok: true, id });
  }
  let mm = p.match(/^\/blockouts\/([a-f0-9]+)$/);
  if (mm && M === "DELETE") { await env.DB.prepare("DELETE FROM blockouts WHERE id = ?").bind(mm[1]).run(); return json({ ok: true }); }
  mm = p.match(/^\/blockouts\/([a-f0-9]+)\/skip$/);
  if (mm && M === "POST") {
    const bo = await env.DB.prepare("SELECT * FROM blockouts WHERE id = ?").bind(mm[1]).first();
    if (!bo || !DAY_RE.test(body.day || "")) return json({ error: "Not found" }, 404);
    if (bo.repeat === "once") { await env.DB.prepare("DELETE FROM blockouts WHERE id = ?").bind(bo.id).run(); return json({ ok: true }); }
    const s = JSON.parse(bo.skip_days || "[]"); if (!s.includes(body.day)) s.push(body.day);
    await env.DB.prepare("UPDATE blockouts SET skip_days = ? WHERE id = ?").bind(JSON.stringify(s), bo.id).run();
    return json({ ok: true });
  }

  if (p === "/jobs" && M === "GET") {
    const scope = url.searchParams.get("scope") || "upcoming", now = Date.now();
    const q = scope === "past" ? "status = 'confirmed' AND end_utc <= ? ORDER BY start_utc DESC" : scope === "cancelled" ? "status = 'cancelled' AND ? > 0 ORDER BY start_utc DESC" : "status = 'confirmed' AND end_utc > ? ORDER BY start_utc";
    const r = (await env.DB.prepare("SELECT * FROM bookings WHERE " + q + " LIMIT 100").bind(now).all()).results || [];
    return json({ jobs: await withThumbs(env, r.map(b => jobRow(b, H, true))) });
  }
  mm = p.match(/^\/jobs\/([A-Z0-9]+)\/ack$/);
  if (mm && M === "POST") { await env.DB.prepare("UPDATE bookings SET acked_at = COALESCE(acked_at, ?) WHERE id = ?").bind(Date.now(), mm[1]).run(); return json({ ok: true }); }

  if (p === "/customers" && M === "GET") {
    const r = (await env.DB.prepare(`SELECT c.id, c.name, c.email, c.phone, c.town, c.cars, c.card, c.created_at,
        (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.kind != 'member') details,
        (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.kind = 'member') visits,
        (SELECT MAX(day) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed') last_day,
        (SELECT COALESCE(SUM(final_cents + COALESCE(tax_cents,0) + COALESCE(tip_cents,0)),0) FROM bookings b WHERE b.customer_id = c.id AND b.paid_at IS NOT NULL) paid,
        (SELECT status FROM memberships m WHERE m.customer_id = c.id AND m.status != 'cancelled' ORDER BY created_at DESC LIMIT 1) member
      FROM customers c ORDER BY c.created_at DESC LIMIT 500`).all()).results || [];
    return json({ customers: r.map(c => { const card = c.card ? JSON.parse(c.card) : null; const cars = JSON.parse(c.cars || "[]");
      return { id: c.id, name: c.name, email: c.email, phone: c.phone, town: c.town, car: cars[0] && cars[0].name, card: card ? card.brand + " ending " + card.last4 : null, details: c.details, visits: c.visits, lastDay: c.last_day, paid: c.paid / 100, member: c.member, since: c.created_at }; }) });
  }

  if (p === "/members" && M === "GET") {
    const r = (await env.DB.prepare("SELECT m.*, c.name, c.email, c.phone FROM memberships m JOIN customers c ON c.id = m.customer_id ORDER BY CASE m.status WHEN 'past_due' THEN 0 WHEN 'active' THEN 1 WHEN 'pending' THEN 2 WHEN 'ending' THEN 3 WHEN 'paused' THEN 4 ELSE 5 END, m.next_bill LIMIT 300").all()).results || [];
    return json({ members: r.map(m => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, status: m.status, label: planLabel(m.type, m.freq, m.size), car: m.car, monthly: m.monthly_cents / 100, since: m.start_day, nextBill: m.next_bill,
      paymentsMade: m.payments_made, credit: m.credit_cents / 100, owed: m.owed_cents / 100, endsOn: m.ends_on, pauseUntil: m.pause_until, cancelMode: m.cancel_mode })) });
  }

  if (p === "/money" && M === "GET") {
    const det = (await env.DB.prepare("SELECT paid_at, COALESCE(final_cents,0) a, COALESCE(tip_cents,0) t, COALESCE(tax_cents,0) x FROM bookings WHERE paid_at IS NOT NULL AND kind != 'member' AND status != 'cancelled'").all()).results || [];
    const methods = (await env.DB.prepare("SELECT paid_method m, COUNT(*) n, COALESCE(SUM(final_cents + COALESCE(tax_cents,0) + COALESCE(tip_cents,0)),0) a FROM bookings WHERE paid_at IS NOT NULL AND kind != 'member' AND status != 'cancelled' GROUP BY paid_method").all()).results || [];
    const mem = (await env.DB.prepare("SELECT for_day, kind, amount_cents a, tax_cents x, created_at FROM membership_charges WHERE status = 'paid'").all()).results || [];
    const byMonth = {};
    const row = mo => byMonth[mo] || (byMonth[mo] = { month: mo, details: 0, tips: 0, jobs: 0, members: 0, fees: 0, tax: 0 });
    // grouped by when the money came in (matches the sales tax quarters)
    for (const r of det) { const x = row(utcToNy(r.paid_at).key.slice(0, 7)); x.details += r.a / 100; x.tips += r.t / 100; x.tax += r.x / 100; x.jobs++; }
    for (const c of mem) { const x = row(utcToNy(c.created_at).key.slice(0, 7)); if (c.kind === "cancel_fee") x.fees += c.a / 100; else x.members += c.a / 100; x.tax += (c.x || 0) / 100; }
    const months = Object.values(byMonth).sort((a, b) => b.month.localeCompare(a.month)).slice(0, 12);
    const unpaid = (await env.DB.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND kind != 'member' AND paid_at IS NULL AND end_utc < ? ORDER BY start_utc DESC LIMIT 30").bind(Date.now()).all()).results || [];
    return json({ months, methods: methods.map(m => ({ method: m.m, count: m.n, total: m.a / 100 })), unpaid: unpaid.map(b => jobRow(b, H, true)), squareSandbox: env.SQUARE_ENV !== "production",
      tax: { name: TAX.name, pct: TAX.pct, quarters: await taxQuarters(env) }, extra: await moneyExtras(env) });
  }
  // mark a quarter's sales tax as filed and paid (or undo)
  mm = p.match(/^\/tax\/(\d{4}-Q[1-4])\/filed$/);
  if (mm && M === "POST") {
    const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'tax_filed'").first(), filed = r ? JSON.parse(r.v) : {};
    if (body.filed === false) delete filed[mm[1]]; else filed[mm[1]] = Date.now();
    await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('tax_filed', ?)").bind(JSON.stringify(filed)).run();
    return json({ ok: true, filed: filed[mm[1]] || null });
  }

  if (p === "/settings" && M === "GET") {
    const sync = await env.DB.prepare("SELECT v FROM meta WHERE k = 'synced'").first();
    return json({ rules: RULES, pricing: PRICING, tax: TAX, membership: { plans: MEM.plans, freqDiscount: MEM.freqDiscount, minPayments: MEM.minPayments, cancelFeeRate: MEM.cancelFeeRate, skipCreditRate: MEM.skipCreditRate, skipNoticeHours: MEM.skipNoticeHours, signupDays: MEM.signupDays },
      sync: sync ? JSON.parse(sync.v) : null, square: env.SQUARE_ENV || "sandbox", calendar: !!(env.ICLOUD_USER && env.ICLOUD_APP_PASSWORD), email: !!env.RESEND_API_KEY, texts: false,
      photos: storageOn(env), edit: currentSettings() });
  }
  if (p === "/status" && M === "GET") {
    const sync = await env.DB.prepare("SELECT v FROM meta WHERE k = 'synced'").first();
    return json({ calendarConnected: !!(env.ICLOUD_USER && env.ICLOUD_APP_PASSWORD), emailConnected: !!env.RESEND_API_KEY, lastSync: sync ? JSON.parse(sync.v) : null });
  }
  if (p === "/sync" && M === "POST") { const r = await H.syncBusy(env); return json(Object.assign({ ok: true }, r)); }

  return json({ error: "Not found" }, 404);
}
