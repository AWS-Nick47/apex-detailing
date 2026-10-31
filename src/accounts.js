// Customer accounts: sign in with a 6-digit code sent by email, 60-day session cookie.
import { send, layout, h } from "./email.js";

const COOKIE = "apex_s", SESSION_DAYS = 60, CODE_MIN = 10;

export async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
}
const rand = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2, "0")).join("");
export const newId = () => rand(9);
export const normEmail = e => String(e || "").trim().toLowerCase();

// ---------- customers ----------
export async function customerByEmail(env, email) {
  return env.DB.prepare("SELECT * FROM customers WHERE email = ?").bind(normEmail(email)).first();
}

// Create or update the customer behind a booking; returns the customer id
export async function upsertFromBooking(env, f) {
  const email = normEmail(f.email), now = Date.now();
  let c = await customerByEmail(env, email);
  const car = f.car ? { name: f.car, color: f.color || "", size: f.size } : null;
  if (!c) {
    const id = newId();
    await env.DB.prepare("INSERT INTO customers (id, email, name, phone, address, town, lat, lon, notes, cars, remind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, email, f.name, f.phone, f.address, f.town || null, f.lat ?? null, f.lon ?? null, null, JSON.stringify(car ? [car] : []), f.remind ?? 1, now, now).run();
    return id;
  }
  const cars = JSON.parse(c.cars || "[]");
  if (car) { const i = cars.findIndex(x => x.name.toLowerCase() === car.name.toLowerCase()); if (i >= 0) cars.splice(i, 1); cars.unshift(car); }
  await env.DB.prepare("UPDATE customers SET name = ?, phone = ?, address = ?, town = ?, lat = COALESCE(?, lat), lon = COALESCE(?, lon), cars = ?, updated_at = ? WHERE id = ?")
    .bind(f.name || c.name, f.phone || c.phone, f.address || c.address, f.town || c.town, f.lat ?? null, f.lon ?? null, JSON.stringify(cars.slice(0, 6)), now, c.id).run();
  return c.id;
}

// Someone who booked before accounts existed: build their account from their latest booking
async function ensureCustomer(env, email) {
  let c = await customerByEmail(env, email);
  if (c) return c;
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE email = ? ORDER BY created_at DESC LIMIT 1").bind(normEmail(email)).first();
  if (!b) return null;
  const id = await upsertFromBooking(env, { email, name: b.name, phone: b.phone, address: b.address, town: b.town, car: b.car, color: b.color, size: b.size, remind: b.remind });
  await env.DB.prepare("UPDATE bookings SET customer_id = ? WHERE email = ? AND customer_id IS NULL").bind(id, normEmail(email)).run();
  return customerByEmail(env, email);
}

// ---------- sessions ----------
function cookieValue(req) { const m = (req.headers.get("Cookie") || "").match(/(?:^|;\s*)apex_s=([a-f0-9]{64})/); return m ? m[1] : null; }

export async function currentCustomer(env, req) {
  const v = cookieValue(req); if (!v) return null;
  const s = await env.DB.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(await sha256(v)).first();
  if (!s || s.expires_at < Date.now()) return null;
  return env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(s.customer_id).first();
}

async function startSession(env, customerId) {
  const v = rand(32), now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id_hash, customer_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(v), customerId, now, now + SESSION_DAYS * 864e5).run();
  return `${COOKIE}=${v}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
}

// ---------- routes ----------
const json = (data, status, headers) => new Response(JSON.stringify(data), { status: status || 200, headers: Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, headers || {}) });

export async function authStart(req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
  const email = normEmail(body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter the email you booked with." }, 400);
  // Same answer whether or not we know the email, so nobody can check who our customers are
  const ok = json({ ok: true });
  const recent = await env.DB.prepare("SELECT COUNT(*) n FROM login_codes WHERE email = ? AND created_at > ?").bind(email, Date.now() - 3600e3).first();
  if (recent && recent.n >= 5) return json({ error: "Too many codes. Try again in an hour, or text (732) 206-7084." }, 429);
  const c = await ensureCustomer(env, email);
  if (!c) { await env.DB.prepare("INSERT INTO login_codes (email, code_hash, created_at, expires_at, used) VALUES (?, 'none', ?, ?, 1)").bind(email, Date.now(), Date.now()).run(); return ok; }
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE email = ? AND used = 0").bind(email).run();
  await env.DB.prepare("INSERT INTO login_codes (email, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(email, await sha256(email + ":" + code), Date.now(), Date.now() + CODE_MIN * 60000).run();
  const subject = "Your Apex sign-in code: " + code;
  const html = layout(subject, `<h1 style="font-size:22px;margin:0 0 10px">Your sign-in code</h1>
    <p style="font-size:38px;font-weight:700;letter-spacing:.18em;margin:18px 0;font-family:ui-monospace,Menlo,monospace">${code}</p>
    <p style="margin:0;color:#444;line-height:1.55">Enter it on apexdetailingoc.com to sign in. It works for ${CODE_MIN} minutes. If you didn't ask for this, you can ignore this email.</p>`, "Code " + code, env.SITE_URL + "/email-logo.png");
  await send(env, { to: email, subject, html, text: "Your Apex Detailing sign-in code is " + code + ". It works for " + CODE_MIN + " minutes." });
  return ok;
}

export async function authVerify(req, env) {
  let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
  const email = normEmail(body.email), code = String(body.code || "").replace(/\D/g, "");
  const row = await env.DB.prepare("SELECT rowid, * FROM login_codes WHERE email = ? AND used = 0 ORDER BY created_at DESC LIMIT 1").bind(email).first();
  if (!row || row.expires_at < Date.now()) return json({ error: "That code expired. Send a new one." }, 400);
  if (row.attempts >= 5) return json({ error: "Too many tries. Send a new code." }, 429);
  if (row.code_hash !== await sha256(email + ":" + code)) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE rowid = ?").bind(row.rowid).run();
    return json({ error: "That code isn't right. Check the email and try again." }, 400);
  }
  await env.DB.prepare("UPDATE login_codes SET used = 1 WHERE rowid = ?").bind(row.rowid).run();
  const c = await customerByEmail(env, email);
  if (!c) return json({ error: "We couldn't find your account." }, 400);
  return json({ ok: true }, 200, { "Set-Cookie": await startSession(env, c.id) });
}

export async function authLogout(req, env) {
  const v = cookieValue(req);
  if (v) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(v)).run();
  return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
}

export async function me(req, env, extra) {
  const c = await currentCustomer(env, req);
  if (!c) return json({ signedIn: false }, 401);
  if (req.method === "POST") {
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const cl = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
    const cars = Array.isArray(body.cars) ? body.cars.slice(0, 6).map(x => ({ name: cl(x.name, 80), color: cl(x.color, 30), size: [0, 1, 2].includes(+x.size) ? +x.size : 0 })).filter(x => x.name) : JSON.parse(c.cars || "[]");
    await env.DB.prepare("UPDATE customers SET name = ?, phone = ?, address = ?, town = ?, notes = ?, cars = ?, remind = ?, updated_at = ? WHERE id = ?")
      .bind(cl(body.name, 80) || c.name, cl(body.phone, 30) || c.phone, cl(body.address, 160) || c.address, cl(body.town, 60) || c.town, cl(body.notes, 500), JSON.stringify(cars), body.remind === false ? 0 : 1, Date.now(), c.id).run();
    return json({ ok: true });
  }
  const r = await env.DB.prepare("SELECT id, token, status, start_utc, end_utc, day, pkg, size, adds, quote, car, color, address, town FROM bookings WHERE customer_id = ? OR email = ? ORDER BY start_utc DESC LIMIT 50").bind(c.id, c.email).all();
  const now = Date.now(), list = (r.results || []).map(b => ({ id: b.id, status: b.status === "cancelled" ? "cancelled" : b.end_utc < now ? "done" : "upcoming", start: b.start_utc, end: b.end_utc, day: b.day,
    pkg: b.pkg, size: b.size, adds: JSON.parse(b.adds || "[]"), quote: b.quote, car: b.car, color: b.color, address: b.address, town: b.town, manage: b.end_utc > now && b.status === "confirmed" ? env.SITE_URL + "/b/" + b.token : null }));
  const card = c.card ? JSON.parse(c.card) : null;
  return json({ signedIn: true, customer: { email: c.email, name: c.name, phone: c.phone, address: c.address, town: c.town, notes: c.notes, cars: JSON.parse(c.cars || "[]"), remind: !!c.remind,
    card: card ? { brand: card.brand, last4: card.last4 } : null }, bookings: list, member: null });
}
