// Apex Detailing — website + booking backend (Cloudflare Worker)
import { RULES, jobMin, dayInfo, slotsFor, nyToUtc, utcToNy, addDays, milesFromHome, parseDay } from "./sched.js";
import { calConfigured, readBusy, writeJob, deleteJob, calendars, jobIcs } from "./cal.js";
import { send, layout, rows, button, h } from "./email.js";

const NAMES = { exterior: "Exterior", interior: "Interior", full: "Full Detail" };
const SIZES = ["Sedan / Coupe", "SUV / Crossover", "Truck / 3-row"];
const ADDON_NAMES = { pet: "Heavy pet hair", stain: "Heavy stain or odor", lights: "Headlight restoration", engine: "Engine bay" };

const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const html = (body, status) => new Response(body, { status: status || 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

function code(n) { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, x => a[x % a.length]).join(""); }
function secret() { return Array.from(crypto.getRandomValues(new Uint8Array(18)), x => x.toString(16).padStart(2, "0")).join(""); }

function todayKey() { return utcToNy(Date.now()).key; }
function tstr(min) { let hh = Math.floor(min / 60); const mm = min % 60, ap = hh >= 12 ? "PM" : "AM"; hh = hh % 12 || 12; return hh + ":" + String(mm).padStart(2, "0") + " " + ap; }
function dayLabel(key, long) { const { y, m, d } = parseDay(key); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: long ? "long" : "short", month: long ? "long" : "short", day: "numeric" }); }
function whenText(b) { const s = utcToNy(b.start_utc), e = utcToNy(b.end_utc); return dayLabel(s.key, true) + ", " + tstr(s.min) + " – " + tstr(e.min); }

// ---------- busy data ----------
async function cachedBusy(env, fromMs, toMs) {
  const r = await env.DB.prepare("SELECT start_utc, end_utc, all_day, kind FROM busy WHERE end_utc > ? AND start_utc < ?").bind(fromMs, toMs).all();
  return r.results || [];
}
async function jobsBetween(env, fromMs, toMs, exceptId) {
  const r = await env.DB.prepare("SELECT id, start_utc, end_utc FROM bookings WHERE status = 'confirmed' AND end_utc > ? AND start_utc < ?").bind(fromMs, toMs).all();
  return (r.results || []).filter(x => x.id !== exceptId);
}

export async function syncBusy(env) {
  if (!calConfigured(env)) return { skipped: "calendar not connected" };
  const from = nyToUtc(todayKey(), 0), to = from + (RULES.horizonDays + 2) * 864e5;
  const { busy, calendars: names } = await readBusy(env, from, to);
  const stmts = [env.DB.prepare("DELETE FROM busy")];
  for (const b of busy) stmts.push(env.DB.prepare("INSERT INTO busy (start_utc, end_utc, all_day, kind) VALUES (?, ?, ?, ?)").bind(b.start_utc, b.end_utc, b.all_day, b.kind));
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('synced', ?)").bind(JSON.stringify({ at: Date.now(), n: busy.length, calendars: names })));
  await env.DB.batch(stmts);
  return { events: busy.length, calendars: names };
}

async function lastSync(env) { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = 'synced'").first(); return r ? JSON.parse(r.v) : null; }

// Days summary for the website picker
async function days(env, fromKey, n, exceptId) {
  const from = nyToUtc(fromKey, 0), to = nyToUtc(addDays(fromKey, n), 0);
  const busy = await cachedBusy(env, from - 864e5, to + 864e5), jobs = await jobsBetween(env, from - 864e5, to + 864e5, exceptId);
  const out = {};
  for (let i = 0; i < n; i++) { const k = addDays(fromKey, i); out[k] = dayInfo(k, busy, jobs); }
  return out;
}

// Re-check one slot right before saving (pulls fresh calendar data for that day when possible)
async function slotOpen(env, key, startMin, pkg, size, adds, exceptId) {
  const d0 = nyToUtc(key, 0) - 864e5, d1 = nyToUtc(addDays(key, 1), 0) + 864e5;
  let busy;
  if (calConfigured(env)) { try { busy = (await readBusy(env, d0, d1)).busy; } catch (e) { busy = null; } }
  if (!busy) busy = await cachedBusy(env, d0, d1);
  const info = dayInfo(key, busy, await jobsBetween(env, d0, d1, exceptId));
  return slotsFor(key, info, pkg, size, adds, Date.now()).includes(startMin);
}

// ---------- validation ----------
function clean(v, max) { return String(v == null ? "" : v).trim().slice(0, max || 200); }
function readBooking(body) {
  const f = {
    pkg: clean(body.pkg, 20), size: +body.size, adds: Array.isArray(body.adds) ? body.adds.map(x => clean(x, 20)) : [],
    day: clean(body.day, 10), start: +body.start,
    name: clean(body.name, 80), phone: clean(body.phone, 30), email: clean(body.email, 120).toLowerCase(),
    address: clean(body.address, 160), town: clean(body.town, 60), car: clean(body.car, 80), color: clean(body.color, 30),
    water: clean(body.water, 5), power: clean(body.power, 5), notes: clean(body.notes, 1500), heard: clean(body.heard, 60),
    quote: Math.round(+body.quote || 0), travel_fee: Math.round(+body.travel_fee || 0), miles: body.miles == null ? null : +body.miles,
    lat: body.lat == null ? null : +body.lat, lon: body.lon == null ? null : +body.lon,
    plan: body.plan && typeof body.plan === "object" ? { label: clean(body.plan.label, 120), monthly: +body.plan.monthly || 0, type: clean(body.plan.type, 10) } : null,
    card: body.card ? 1 : 0, remind: body.texts === false ? 0 : 1
  };
  const err = [];
  if (!NAMES[f.pkg]) err.push("package");
  if (![0, 1, 2].includes(f.size)) err.push("vehicle size");
  f.adds = [...new Set(f.adds)].filter(a => RULES.addonPkgs[a] && RULES.addonPkgs[a].includes(f.pkg));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.day) || !(f.start >= 0 && f.start < 1440)) err.push("time");
  if (f.name.length < 2) err.push("name");
  if (f.phone.replace(/\D/g, "").length < 10) err.push("phone");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) err.push("email");
  if (f.address.length < 4) err.push("address");
  if (f.pkg !== "interior" && f.water === "no") err.push("water spigot");
  if (f.power === "no") err.push("outlet");
  if (f.lat != null && f.lon != null && isFinite(f.lat) && isFinite(f.lon)) f.miles = Math.round(milesFromHome(f.lat, f.lon) * 10) / 10;
  if (f.miles != null && f.miles > RULES.maxMiles) err.push("distance");
  return { f, err };
}

// ---------- emails ----------
function details(b) {
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  return [["When", whenText(b)], ["Package", NAMES[b.pkg] + " · " + SIZES[b.size]], ["Add-ons", adds], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Where", [b.address, b.town].filter(Boolean).join(", ")], ["Estimate", b.quote ? "$" + b.quote + (b.travel_fee ? " (includes $" + b.travel_fee + " travel)" : "") + " · pay after the job" : ""], ["Booking code", b.id]];
}
function needsText(pkg) { return pkg === "interior" ? "an outlet we can reach (an indoor one is fine if we can run a cord outside)" : "an outdoor water spigot and an outlet we can reach"; }

async function emailCustomer(env, b, kind) {
  const site = env.SITE_URL, manage = site + "/b/" + b.token, logo = site + "/email-logo.png";
  const ics = jobIcs(b, { summary: "Apex Detailing · " + NAMES[b.pkg], location: [b.address, b.town].filter(Boolean).join(", "), description: "Booking " + b.id + ". Manage: " + manage, url: manage });
  const first = b.name.split(" ")[0];
  let subject, intro;
  if (kind === "cancel") { subject = "Cancelled: your " + NAMES[b.pkg] + " on " + dayLabel(utcToNy(b.start_utc).key); intro = `<h1 style="font-size:24px;margin:0 0 8px">Your detail is cancelled</h1><p style="margin:0;color:#444;line-height:1.55">Hi ${h(first)}, we've cancelled this booking. Whenever you're ready, you can book again at <a href="${h(site)}" style="color:#111">apexdetailingoc.com</a>.</p>`; }
  else if (kind === "move") { subject = "New time: " + NAMES[b.pkg] + " · " + whenText(b); intro = `<h1 style="font-size:24px;margin:0 0 8px">Your detail has a new time</h1><p style="margin:0;color:#444;line-height:1.55">Hi ${h(first)}, you're all set for the new time below.</p>`; }
  else if (kind === "remind") { subject = "Tomorrow: your " + NAMES[b.pkg] + " at " + tstr(utcToNy(b.start_utc).min); intro = `<h1 style="font-size:24px;margin:0 0 8px">See you tomorrow, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">Just a reminder about your detail. Here are the details:</p>`; }
  else { subject = "You're booked: " + NAMES[b.pkg] + " · " + whenText(b); intro = `<h1 style="font-size:24px;margin:0 0 8px">You're booked, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">Thanks for choosing Apex. We'll come to you. Here are the details:</p>`; }
  const after = kind === "cancel" ? "" :
    `<p style="margin:0 0 6px;font-weight:700">Before we arrive</p><p style="margin:0 0 18px;color:#444;line-height:1.55">Please make sure we have ${needsText(b.pkg)}, and take valuables out of the car. Final price depends on condition; we confirm before we start, never after.</p>
     <p style="margin:0 0 20px">${button(manage, "Reschedule or cancel")}</p>
     <p style="margin:0;color:#666;font-size:13px;line-height:1.5">Questions? Just reply to this email or text (732) 206-7084.</p>`;
  return send(env, {
    to: b.email, subject,
    html: layout(subject, intro + rows(details(b)) + after, kind === "cancel" ? "Your booking is cancelled" : whenText(b), logo),
    attachments: kind === "cancel" || kind === "remind" ? undefined : [{ filename: "apex-detail.ics", content: btoa(unescape(encodeURIComponent(ics))), content_type: "text/calendar" }]
  });
}

async function emailNick(env, b, kind, extra) {
  const site = env.SITE_URL, where = [b.address, b.town].filter(Boolean).join(", ");
  const maps = "https://maps.apple.com/?daddr=" + encodeURIComponent(where), tel = b.phone.replace(/[^\d+]/g, "");
  const town = b.town || "", label = { new: "New booking", cancel: "Cancelled", move: "Rescheduled" }[kind];
  const subject = label + ": " + NAMES[b.pkg] + " · " + whenText(b) + (town ? " · " + town : "");
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  const plan = b.plan ? JSON.parse(b.plan) : null;
  const list = [["When", whenText(b)], ["Customer", h(b.name) + `<br><a href="tel:${h(tel)}" style="color:#111">${h(b.phone)}</a> · <a href="sms:${h(tel)}" style="color:#111">Text</a><br><a href="mailto:${h(b.email)}" style="color:#111">${h(b.email)}</a>`, true],
    ["Address", `${h(where)}<br><a href="${h(maps)}" style="color:#111">Directions</a>` + (b.miles != null ? ` · ${h(b.miles)} mi` : ""), true],
    ["Package", NAMES[b.pkg] + " · " + SIZES[b.size]], ["Add-ons", adds], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Water / power", (b.pkg === "interior" ? "" : "Spigot: " + (b.water || "?") + " · ") + "Outlet: " + (b.power || "?")],
    ["Estimate", b.quote ? "$" + b.quote + (b.travel_fee ? " (incl. $" + b.travel_fee + " travel)" : "") : ""],
    ["Payment", b.card_on_file ? "Wants card on file (Square not connected yet — collect in person)" : "In person"],
    ["Membership", plan ? plan.label + " · $" + plan.monthly + "/mo" : ""], ["Notes", b.notes], ["Heard about us", b.heard], ["Code", b.id]];
  if (extra) list.unshift(["Was", extra]);
  const body = `<h1 style="font-size:22px;margin:0 0 6px">${h(label)}</h1><p style="margin:0;color:#444">${h(whenText(b))}</p>` + rows(list) +
    (kind === "new" ? `<p style="margin:0 0 10px">${button(site + "/ack/" + b.ack_token, "Got it")}</p><p style="margin:0;color:#777;font-size:13px">The customer is already confirmed. "Got it" just marks it seen for you. It's in your Apex Jobs calendar.</p>` : "");
  return send(env, { to: env.NICK_EMAIL, reply_to: b.email, subject, html: layout(subject, body, label, site + "/email-logo.png") });
}

// ---------- pages (manage booking / got it) ----------
function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Apex Detailing</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}body{margin:0;background:#0a0a0a;color:#ededed;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.w{max-width:560px;margin:0 auto;padding:28px 16px 60px}.brand{font-weight:700;letter-spacing:.18em;font-size:13px;color:#bbb;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.brand svg{width:20px;height:20px}h1{font-size:28px;line-height:1.15;margin:22px 0 6px;letter-spacing:-.02em}.sub{color:#a3a3a3;margin:0 0 20px}
.card{background:rgba(255,255,255,.06);border-radius:20px;padding:6px 18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.r{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.08)}.r:last-child{border:0}.r span{color:#a3a3a3}.r b{text-align:right;font-weight:600}
.btn{display:inline-flex;justify-content:center;align-items:center;min-height:48px;padding:0 20px;border-radius:999px;border:0;background:#ededed;color:#0a0a0a;font:600 15px/1 inherit;cursor:pointer;text-decoration:none}
.btn.g{background:rgba(255,255,255,.08);color:#ededed}.btn.d{background:transparent;color:#ff8a80;box-shadow:inset 0 0 0 1px rgba(255,138,128,.4)}
.acts{display:grid;gap:10px;margin-top:20px}h2{font-size:18px;margin:28px 0 10px}.days{display:grid;gap:14px}.day b{display:block;margin-bottom:8px}
.ts{display:flex;flex-wrap:wrap;gap:8px}.ts button{min-height:42px;padding:0 14px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:#ededed;font:600 14px inherit;cursor:pointer}
.ts button:hover{background:rgba(255,255,255,.16)}.note{color:#a3a3a3;font-size:14px}.ok{width:56px;height:56px;border-radius:50%;background:#ededed;color:#0a0a0a;display:grid;place-items:center;font-size:28px;margin-top:24px}
form{margin:0}</style></head><body><div class="w"><a class="brand" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20 L10 6 L13 11 L15.5 8 L22 20 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.3 9 L10 6 L11.8 9.2 L10 8.4 Z" fill="currentColor"/></svg>APEX DETAILING</a>${inner}</div></body></html>`;
}

function summaryCard(b) {
  return `<div class="card">${details(b).filter(r => r[1]).map(r => `<div class="r"><span>${h(r[0])}</span><b>${h(r[1])}</b></div>`).join("")}</div>`;
}

async function managePage(env, b, msg) {
  if (b.status === "cancelled") return page("Cancelled", `<h1>This booking is cancelled</h1><p class="sub">${msg ? h(msg) + " " : ""}Want a new time? <a href="/" style="color:#ededed">Book again</a>.</p>${summaryCard(b)}`);
  const hoursLeft = (b.start_utc - Date.now()) / 3600e3;
  const head = `<h1>Your ${h(NAMES[b.pkg])}</h1><p class="sub">${h(whenText(b))}</p>${msg ? `<p class="note" style="color:#c8f7c5">${h(msg)}</p>` : ""}${summaryCard(b)}`;
  if (hoursLeft < RULES.noticeHours) return page("Your booking", head + `<p class="note" style="margin-top:18px">It's less than 24 hours away, so changes go through us directly: text or call <a href="sms:7322067084" style="color:#ededed">(732) 206-7084</a>.</p>`);
  // next open times for the same job (next 21 days), excluding this booking itself
  const adds = JSON.parse(b.adds || "[]"), start = addDays(todayKey(), 1), info = await days(env, start, 21, b.id), opts = [];
  for (const k of Object.keys(info)) { const s = slotsFor(k, info[k], b.pkg, b.size, adds, Date.now()); if (s.length) opts.push([k, s]); if (opts.length >= 8) break; }
  const pick = opts.length ? `<div class="days">${opts.map(([k, s]) => `<div class="day"><b>${h(dayLabel(k, true))}</b><div class="ts">${s.slice(0, 8).map(t => `<form method="post" action="/b/${b.token}/move"><input type="hidden" name="day" value="${k}"><input type="hidden" name="start" value="${t}"><button>${tstr(t)}</button></form>`).join("")}</div></div>`).join("")}</div>`
    : `<p class="note">No other open times in the next 3 weeks. Text us at (732) 206-7084 and we'll work something out.</p>`;
  return page("Your booking", head + `<h2>Pick a new time</h2>${pick}<h2>Cancel</h2><form method="post" action="/b/${b.token}/cancel" onsubmit="return confirm('Cancel this detail?')"><button class="btn d" style="width:100%">Cancel my detail</button></form><p class="note">Free to change or cancel up to 24 hours before.</p>`);
}

// ---------- routes ----------
async function api(req, env, url) {
  const p = url.pathname;

  if (p === "/api/days" && req.method === "GET") {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : todayKey();
    const n = Math.min(70, Math.max(1, +url.searchParams.get("n") || 45));
    const s = await lastSync(env);
    return json({ now: Date.now(), rules: { startMin: RULES.startMin, gapMin: RULES.gapMin, noticeHours: RULES.noticeHours, stepMin: RULES.stepMin, maxJobs: RULES.maxJobs, maxJobsDayOff: RULES.maxJobsDayOff, horizonDays: RULES.horizonDays },
      calendar: calConfigured(env) ? (s ? "synced" : "pending") : "not-connected", syncedAt: s && s.at, days: await days(env, from, n) });
  }

  if (p === "/api/book" && req.method === "POST") {
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (body.website) return json({ ok: true, id: "OK" });   // spam trap
    const { f, err } = readBooking(body);
    if (err.length) return json({ error: "Please check: " + err.join(", ") }, 400);
    const max = addDays(todayKey(), RULES.horizonDays);
    if (f.day > max) return json({ error: "That date is too far out." }, 400);
    if (!(await slotOpen(env, f.day, f.start, f.pkg, f.size, f.adds))) return json({ error: "Sorry, that time was just taken. Please pick another.", taken: true }, 409);
    const start_utc = nyToUtc(f.day, f.start), end_utc = start_utc + jobMin(f.pkg, f.size, f.adds) * 60000;
    const b = { id: code(6), token: secret(), ack_token: secret(), status: "confirmed", created_at: Date.now(), start_utc, end_utc, day: f.day, pkg: f.pkg, size: f.size, adds: JSON.stringify(f.adds),
      plan: f.plan ? JSON.stringify(f.plan) : null, quote: f.quote, travel_fee: f.travel_fee, miles: f.miles, name: f.name, phone: f.phone, email: f.email, address: f.address, town: f.town,
      car: f.car, color: f.color, water: f.water, power: f.power, concerns: null, heard: f.heard, notes: f.notes, card_on_file: f.card, remind: f.remind, cal_href: null };
    await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, plan, quote, travel_fee, miles, name, phone, email, address, town, car, color, water, power, heard, notes, card_on_file, remind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.plan,
      b.quote, b.travel_fee, b.miles, b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.heard, b.notes, b.card_on_file, b.remind).run();
    // calendar + emails: don't let a hiccup there lose the booking
    const tasks = [];
    if (calConfigured(env)) tasks.push(calSave(env, b).catch(e => console.log("calendar save failed", e.message)));
    tasks.push(emailCustomer(env, b, "new").catch(e => console.log("customer email failed", e.message)));
    tasks.push(emailNick(env, b, "new").catch(e => console.log("nick email failed", e.message)));
    await Promise.all(tasks);
    return json({ ok: true, id: b.id, token: b.token, start: b.start_utc, end: b.end_utc, manage: env.SITE_URL + "/b/" + b.token });
  }

  if (p === "/api/status" && req.method === "GET") {
    const s = await lastSync(env);
    let cals = null;
    if (url.searchParams.get("cal") === "1" && calConfigured(env)) { try { cals = (await calendars(env, true)).map(c => c.name); } catch (e) { cals = "error: " + e.message; } }
    return json({ calendarConnected: calConfigured(env), emailConnected: !!env.RESEND_API_KEY, lastSync: s, calendars: cals });
  }

  return json({ error: "Not found" }, 404);
}

// Day-before reminder emails, sent from 6 PM New York time
async function reminders(env) {
  const now = utcToNy(Date.now()); if (now.min < 18 * 60) return;
  const tmr = addDays(now.key, 1);
  const r = await env.DB.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND day = ? AND remind = 1 AND reminded_at IS NULL").bind(tmr).all();
  for (const b of r.results || []) {
    await emailCustomer(env, b, "remind");
    await env.DB.prepare("UPDATE bookings SET reminded_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
  }
}

async function calSave(env, b) {
  const where = [b.address, b.town].filter(Boolean).join(", "), adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a);
  const desc = [b.name + " · " + b.phone, b.email, NAMES[b.pkg] + " · " + SIZES[b.size] + (adds.length ? " + " + adds.join(", ") : ""), [b.car, b.color].filter(Boolean).join(" · "),
    b.quote ? "Estimate $" + b.quote : "", b.pkg === "interior" ? "Outlet: " + b.power : "Spigot: " + b.water + " · Outlet: " + b.power, b.notes ? "Notes: " + b.notes : "", "Code " + b.id].filter(Boolean).join("\n");
  const href = await writeJob(env, b, { summary: NAMES[b.pkg] + " · " + b.name.split(" ")[0] + (b.town ? " · " + b.town : ""), location: where, description: desc });
  if (href) await env.DB.prepare("UPDATE bookings SET cal_href = ? WHERE id = ?").bind(href, b.id).run();
  b.cal_href = href;
}

async function manage(req, env, url) {
  const m = url.pathname.match(/^\/b\/([a-f0-9]{36})(?:\/(cancel|move))?$/);
  if (!m) return html(page("Not found", "<h1>Link not found</h1>"), 404);
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE token = ?").bind(m[1]).first();
  if (!b) return html(page("Not found", `<h1>We couldn't find that booking</h1><p class="sub">Text us at (732) 206-7084 and we'll sort it out.</p>`), 404);
  if (!m[2] || req.method !== "POST") return html(await managePage(env, b));
  if (b.status !== "confirmed") return html(await managePage(env, b));
  if ((b.start_utc - Date.now()) / 3600e3 < RULES.noticeHours) return html(await managePage(env, b, "It's too close to change online."));
  if (m[2] === "cancel") {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
    b.status = "cancelled";
    await Promise.all([deleteJob(env, b.cal_href).catch(() => {}), emailCustomer(env, b, "cancel").catch(() => {}), emailNick(env, b, "cancel").catch(() => {})]);
    return html(await managePage(env, b, "Done."));
  }
  const fd = await req.formData(), day = String(fd.get("day") || ""), start = +fd.get("start");
  const adds = JSON.parse(b.adds || "[]");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(await slotOpen(env, day, start, b.pkg, b.size, adds, b.id))) return html(await managePage(env, b, "Sorry, that time was just taken. Pick another."));
  const was = whenText(b), start_utc = nyToUtc(day, start), end_utc = start_utc + jobMin(b.pkg, b.size, adds) * 60000;
  const hist = JSON.parse(b.history || "[]"); hist.push({ at: Date.now(), from: b.start_utc });
  await env.DB.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, day = ?, history = ? WHERE id = ?").bind(start_utc, end_utc, day, JSON.stringify(hist), b.id).run();
  Object.assign(b, { start_utc, end_utc, day });
  await Promise.all([calConfigured(env) ? calSave(env, b).catch(() => {}) : null, emailCustomer(env, b, "move").catch(() => {}), emailNick(env, b, "move", was).catch(() => {})]);
  return html(await managePage(env, b, "Moved. We sent you a new confirmation."));
}

async function ack(env, url) {
  const t = url.pathname.split("/")[2] || "";
  const b = /^[a-f0-9]{36}$/.test(t) ? await env.DB.prepare("SELECT * FROM bookings WHERE ack_token = ?").bind(t).first() : null;
  if (!b) return html(page("Not found", "<h1>Link not found</h1>"), 404);
  if (!b.acked_at) await env.DB.prepare("UPDATE bookings SET acked_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
  return html(page("Got it", `<div class="ok">✓</div><h1>Got it</h1><p class="sub">${h(b.name)} · ${h(whenText(b))}</p>${summaryCard(b)}`));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname.startsWith("/b/")) return await manage(req, env, url);
      if (url.pathname.startsWith("/ack/")) return await ack(env, url);
    } catch (e) {
      console.log("error", e.stack || e.message);
      return url.pathname.startsWith("/api/") ? json({ error: "Something went wrong on our side. Please text (732) 206-7084." }, 500) : html(page("Error", "<h1>Something went wrong</h1><p class='sub'>Please text (732) 206-7084.</p>"), 500);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncBusy(env).then(r => console.log("sync", JSON.stringify(r))).catch(e => console.log("sync failed", e.message)));
    ctx.waitUntil(reminders(env).catch(e => console.log("reminders failed", e.message)));
  }
};

export { emailCustomer, emailNick };
