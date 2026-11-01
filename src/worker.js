// Apex Detailing — website + booking backend (Cloudflare Worker)
import { RULES, jobMin, dayInfo, slotsFor, nyToUtc, utcToNy, addDays, milesFromHome, parseDay, townCoords } from "./sched.js";
import { calConfigured, readBusy, writeJob, deleteJob, calendars, jobIcs } from "./cal.js";
import { send, layout, rows, button, h } from "./email.js";
import { quote as priceQuote, travelFee, TAX, withTax, PRICING } from "./pricing.js";
import { authStart, authVerify, authLogout, me, upsertFromBooking, normEmail, currentCustomer } from "./accounts.js";
import { jobRoute, payPage, payApi, publicConfig } from "./pay.js";
import { squareOn, saveCard, removeCard } from "./square.js";
import { adminApi, accessUser, blockoutBusy } from "./admin.js";
import { MEM, createMembership, activeFor, summary as memSummary, visitSlots, runBilling, cancelMembership, pauseMembership, retryNow, coverOn, addMonths, qualifyingFor, moveWithDetail, cancelWithDetail, planLabel } from "./membership.js";

const NAMES = { exterior: "Exterior", interior: "Interior", full: "Full Detail" };
const TERMS_VERSION = "2026-11-01";   // bump when terms.html / membership-terms.html / privacy.html change
const SIZES = ["Sedan / Coupe", "SUV / Crossover", "Truck / 3-row"];
const VISIT_NAMES = { exterior: "Wash visit", interior: "Interior visit", full: "Wash + interior visit" };
const pkgName = b => b.kind === "member" ? VISIT_NAMES[b.pkg] : NAMES[b.pkg];
const ADDON_NAMES = { pet: "Heavy pet hair", stain: "Heavy stain or odor", lights: "Headlight restoration", engine: "Engine bay" };

const usd = c => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);   // cents -> "$244.17" / "$229"
const taxLabel = TAX.name + " (" + TAX.pct + ")";
// the membership line in booking emails: "Wash + interior, monthly (Sedan) · $95/mo + tax ($101.29), first charge Dec 1"
const memLine = m => m.label + " · $" + m.monthly + "/mo + tax (" + usd(withTax(m.monthly * 100).total) + "), first charge " + dayLabel(m.firstBill);
// estimate rows for a detail: price before tax, the tax, and the estimated total
function priceRows(b) {
  if (b.kind === "member") return [["Price", "Included in your Apex Membership"]];
  if (b.final_cents != null && (b.paid_at || b.completed_at)) {   // after the job: what was billed / paid
    const tax = b.tax_cents || 0, tip = b.paid_at ? (b.tip_cents || 0) : 0;
    return [["Price", usd(b.final_cents)], b.tax_cents != null ? [taxLabel, usd(tax)] : null, tip ? ["Tip", usd(tip)] : null, [b.paid_at ? "Paid" : "Amount due", usd(b.final_cents + tax + tip)]].filter(Boolean);
  }
  if (!b.quote) return [];
  const e = withTax(b.quote * 100);
  return [["Estimate", usd(e.sub) + (b.travel_fee ? " (includes $" + b.travel_fee + " travel)" : "")], [taxLabel, usd(e.tax)], ["Estimated total", usd(e.total) + " · pay after the job"]];
}
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
  const busy = (await cachedBusy(env, from - 864e5, to + 864e5)).concat(await blockoutBusy(env, from - 864e5, to + 864e5)), jobs = await jobsBetween(env, from - 864e5, to + 864e5, exceptId);
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
  busy = busy.concat(await blockoutBusy(env, d0, d1));
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
    quote: Math.round(+body.quote || 0), travel_fee: 0, miles: null,   // the server works out distance and travel itself
    lat: body.lat == null ? null : +body.lat, lon: body.lon == null ? null : +body.lon,
    plan: body.plan && typeof body.plan === "object" && MEM.plans[body.plan.type] ? { type: clean(body.plan.type, 10), freq: [1, 2, 4].includes(+body.plan.freq) ? +body.plan.freq : 1 } : null,
    card: body.card ? 1 : 0, remind: body.texts === false ? 0 : 1, cardToken: body.cardToken ? String(body.cardToken).slice(0, 400) : null, postal: clean(body.postal, 10),
    agree: body.agree === true, sms: body.sms === true, memAuth: body.memAuth === true
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
  if (!f.agree) err.push("agreement to the Terms of Service");
  if (f.plan && !f.memAuth) err.push("membership charge authorization");
  // distance comes from the address pin (or the town's center), never from the browser's number (audit IA-009)
  const pinOk = f.lat != null && f.lon != null && isFinite(f.lat) && isFinite(f.lon) && f.lat > 38 && f.lat < 42.5 && f.lon > -77 && f.lon < -72;
  const pin = pinOk ? [f.lat, f.lon] : townCoords(f.town);
  if (!pinOk) { f.lat = pin ? pin[0] : null; f.lon = pin ? pin[1] : null; }
  if (pin) f.miles = Math.round(milesFromHome(pin[0], pin[1]) * 10) / 10; else err.push("location");
  if (f.miles != null && f.miles > RULES.maxMiles) err.push("distance");
  return { f, err };
}

// ---------- emails ----------
function details(b) {
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  return [["When", whenText(b)], ["Package", pkgName(b) + " · " + SIZES[b.size]], ["Add-ons", adds], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Where", [b.address, b.town].filter(Boolean).join(", ")], ...priceRows(b),
    b._mem ? ["Apex Membership", memLine(b._mem)] : null, ["Booking code", b.id]].filter(Boolean);
}
function needsText(pkg) { return pkg === "interior" ? "an outlet we can reach (an indoor one is fine if we can run a cord outside)" : "an outdoor water spigot and an outlet we can reach"; }

async function emailCustomer(env, b, kind) {
  const site = env.SITE_URL, manage = site + "/b/" + b.token, logo = site + "/email-logo.png";
  const ics = jobIcs(b, { summary: "Apex Detailing · " + pkgName(b), location: [b.address, b.town].filter(Boolean).join(", "), description: "Booking " + b.id + ". Manage: " + manage, url: manage });
  const first = b.name.split(" ")[0];
  let subject, intro;
  if (kind === "cancel") { subject = "Cancelled: your " + pkgName(b) + " on " + dayLabel(utcToNy(b.start_utc).key); intro = `<h1 style="font-size:24px;margin:0 0 8px">Your detail is cancelled</h1><p style="margin:0;color:#444;line-height:1.55">Hi ${h(first)}, we've cancelled this booking. Whenever you're ready, you can book again at <a href="${h(site)}" style="color:#111">apexdetailingoc.com</a>.</p>`; }
  else if (kind === "move") { subject = "New time: " + pkgName(b) + " · " + whenText(b); intro = `<h1 style="font-size:24px;margin:0 0 8px">Your detail has a new time</h1><p style="margin:0;color:#444;line-height:1.55">Hi ${h(first)}, you're all set for the new time below.</p>`; }
  else if (kind === "remind") { subject = "Tomorrow: your " + pkgName(b) + " at " + tstr(utcToNy(b.start_utc).min); intro = `<h1 style="font-size:24px;margin:0 0 8px">See you tomorrow, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">Just a reminder about your detail. Here are the details:</p>`; }
  else { subject = "You're booked: " + pkgName(b) + " · " + whenText(b); intro = `<h1 style="font-size:24px;margin:0 0 8px">You're booked, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">Thanks for choosing Apex. We'll come to you. Here are the details:</p>`; }
  const after = kind === "cancel" ? "" :
    `<p style="margin:0 0 6px;font-weight:700">Before we arrive</p><p style="margin:0 0 18px;color:#444;line-height:1.55">Please make sure we have ${needsText(b.pkg)}, and take valuables out of the car. ${b.kind === "member" ? "This visit is included in your Apex Membership." : "Final price depends on condition; we confirm before we start, never after."}</p>
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
  const subject = label + ": " + pkgName(b) + " · " + whenText(b) + (town ? " · " + town : "");
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  const plan = b.plan ? JSON.parse(b.plan) : null;
  const list = [["When", whenText(b)], ["Customer", h(b.name) + `<br><a href="tel:${h(tel)}" style="color:#111">${h(b.phone)}</a> · <a href="sms:${h(tel)}" style="color:#111">Text</a><br><a href="mailto:${h(b.email)}" style="color:#111">${h(b.email)}</a>`, true],
    ["Address", `${h(where)}<br><a href="${h(maps)}" style="color:#111">Directions</a>` + (b.miles != null ? ` · ${h(b.miles)} mi` : ""), true],
    ["Package", pkgName(b) + " · " + SIZES[b.size]], ["Add-ons", adds], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Water / power", (b.pkg === "interior" ? "" : "Spigot: " + (b.water || "?") + " · ") + "Outlet: " + (b.power || "?")],
    ["Estimate", b.quote ? (e => usd(e.sub) + " + " + usd(e.tax) + " tax = " + usd(e.total))(withTax(b.quote * 100)) + (b.travel_fee ? " (incl. $" + b.travel_fee + " travel)" : "") : ""],
    ["Payment", b.kind === "member" ? "Apex Membership visit (included)" : b.card ? "Card on file: " + JSON.parse(b.card).brand + " ending " + JSON.parse(b.card).last4 + " (charge after the job)" : "In person"],
    ["Membership", b._mem ? "Signed up: " + memLine(b._mem) : b._memErr ? "Tried to sign up but: " + b._memErr : ""], ["Notes", b.notes], ["Heard about us", b.heard], ["Code", b.id]];
  if (extra) list.unshift(["Was", extra]);
  const body = `<h1 style="font-size:22px;margin:0 0 6px">${h(label)}</h1><p style="margin:0;color:#444">${h(whenText(b))}</p>` + rows(list) +
    (kind === "new" ? `<p style="margin:0 0 10px">${button(site + "/ack/" + b.ack_token, "Got it")} &nbsp; ${button(site + "/job/" + b.ack_token, "Job done — get paid", false)}</p><p style="margin:0;color:#777;font-size:13px">The customer is already confirmed. "Got it" just marks it seen for you. After the job, open "Job done — get paid" to charge their card, send a pay link, or mark it paid in person. It's in your Apex Jobs calendar.</p>` : "");
  return send(env, { to: env.NICK_EMAIL, reply_to: b.email, subject, html: layout(subject, body, label, site + "/email-logo.png") });
}

// ---------- pages (manage booking / got it) ----------
function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Apex Detailing</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}html{background:#0a0a0a;min-height:100%}body{margin:0;background:#0a0a0a;min-height:100vh;color:#ededed;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.w{max-width:560px;margin:0 auto;padding:28px 16px 60px}.brand{font-weight:700;letter-spacing:.18em;font-size:13px;color:#bbb;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.brand svg{width:20px;height:20px}h1{font-size:28px;line-height:1.15;margin:22px 0 6px;letter-spacing:-.02em}.sub{color:#a3a3a3;margin:0 0 20px}
.card{background:rgba(255,255,255,.06);border-radius:20px;padding:6px 18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.r{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.08)}.r:last-child{border:0}.r span{color:#a3a3a3}.r b{text-align:right;font-weight:600}
.btn{display:inline-flex;justify-content:center;align-items:center;min-height:48px;padding:0 20px;border-radius:999px;border:0;background:#ededed;color:#0a0a0a;font-family:inherit;font-size:15px;font-weight:600;line-height:1;cursor:pointer;text-decoration:none}
.btn.g{background:rgba(255,255,255,.08);color:#ededed}.btn.d{background:transparent;color:#ff8a80;box-shadow:inset 0 0 0 1px rgba(255,138,128,.4)}
.acts{display:grid;gap:10px;margin-top:20px}h2{font-size:18px;margin:28px 0 10px}.days{display:grid;gap:14px}.day b{display:block;margin-bottom:8px}
.ts{display:flex;flex-wrap:wrap;gap:8px}.ts button{min-height:42px;padding:0 14px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:#ededed;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.ts button:hover{background:rgba(255,255,255,.16)}.note{color:#a3a3a3;font-size:14px}.ok{width:56px;height:56px;border-radius:50%;background:#ededed;color:#0a0a0a;display:grid;place-items:center;font-size:28px;margin-top:24px}
form{margin:0}.ts button[aria-pressed="true"]{background:#ededed;color:#0a0a0a}.r input[type=radio]{margin-right:8px}.btn:disabled{opacity:.5}</style></head><body><div class="w"><a class="brand" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20 L10 6 L13 11 L15.5 8 L22 20 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.3 9 L10 6 L11.8 9.2 L10 8.4 Z" fill="currentColor"/></svg>APEX DETAILING</a>${inner}</div></body></html>`;
}

function summaryCard(b) {
  return `<div class="card">${details(b).filter(r => r[1]).map(r => `<div class="r"><span>${h(r[0])}</span><b>${h(r[1])}</b></div>`).join("")}</div>`;
}

async function managePage(env, b, msg) {
  if (b.status === "cancelled") return b.kind === "member" ? page("Skipped", `<h1>This visit is skipped</h1><p class="sub">${msg ? h(msg) + " " : ""}It counts as this month's visit. <a href="/#account" style="color:#ededed">Your account</a> shows your membership and next visits.</p>${summaryCard(b)}`)
    : page("Cancelled", `<h1>This booking is cancelled</h1><p class="sub">${msg ? h(msg) + " " : ""}Want a new time? <a href="/#book" style="color:#ededed">Book again</a>.</p>${summaryCard(b)}`);
  const hoursLeft = (b.start_utc - Date.now()) / 3600e3;
  const head = `<h1>Your ${h(pkgName(b))}</h1><p class="sub">${h(whenText(b))}</p>${msg ? `<p class="note" style="color:#c8f7c5">${h(msg)}</p>` : ""}${summaryCard(b)}`;
  const member = b.kind === "member" ? await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(b.membership_id).first() : null;
  if (member) {
    const credit = hoursLeft >= MEM.skipNoticeHours ? Math.round((b.visit_value_cents || 0) * MEM.skipCreditRate) : 0;
    const skip = `<h2>Can't make it?</h2><form method="post" action="/b/${b.token}/cancel" onsubmit="return confirm('Skip this visit? It still counts as this month\\'s visit.')"><button class="btn d" style="width:100%">Skip this visit</button></form><p class="note">A skipped visit still counts as this month's visit. ${credit ? "With 48+ hours' notice you get a $" + (credit / 100).toFixed(credit % 100 ? 2 : 0) + " credit (50%) on your next monthly charge." : "Less than 48 hours' notice, so no credit for this visit."}</p>`;
    if (hoursLeft < RULES.noticeHours) return page("Your visit", head + skip + `<p class="note">To move it instead, text or call <a href="sms:7322067084" style="color:#ededed">(732) 206-7084</a>.</p>`);
    const from = addDays(todayKey(), 1), n = Math.max(1, Math.min(35, Math.round((nyToUtc(member.period_end || from, 0) - nyToUtc(from, 0)) / 864e5)));
    const info = await days(env, from, n, b.id), opts = [];
    for (const k of Object.keys(info)) { if (member.period_end && k >= member.period_end) break; const cv = coverOn(member.type, k); if (!cv) continue; const sl = slotsFor(k, info[k], MEM.visitPkg[cv], b.size, ["_member"], Date.now()); if (sl.length) opts.push([k, sl]); if (opts.length >= 8) break; }
    const pick = opts.length ? `<div class="days">${opts.map(([k, sl]) => `<div class="day"><b>${h(dayLabel(k, true))}</b><div class="ts">${sl.slice(0, 8).map(t => `<form method="post" action="/b/${b.token}/move"><input type="hidden" name="day" value="${k}"><input type="hidden" name="start" value="${t}"><button>${tstr(t)}</button></form>`).join("")}</div></div>`).join("")}</div>` : `<p class="note">No other open times left in this month's period.</p>`;
    return page("Your visit", head + `<h2>Pick a new time</h2>${pick}${skip}`);
  }
  if (hoursLeft < RULES.noticeHours) return page("Your booking", head + `<p class="note" style="margin-top:18px">It's less than 24 hours away, so changes go through us directly: text or call <a href="sms:7322067084" style="color:#ededed">(732) 206-7084</a>.</p>`);
  // next open times for the same job (next 21 days), excluding this booking itself
  const adds = JSON.parse(b.adds || "[]"), start = addDays(todayKey(), 1), info = await days(env, start, 21, b.id), opts = [];
  for (const k of Object.keys(info)) { const s = slotsFor(k, info[k], b.pkg, b.size, adds, Date.now()); if (s.length) opts.push([k, s]); if (opts.length >= 8) break; }
  const pick = opts.length ? `<div class="days">${opts.map(([k, s]) => `<div class="day"><b>${h(dayLabel(k, true))}</b><div class="ts">${s.slice(0, 8).map(t => `<form method="post" action="/b/${b.token}/move"><input type="hidden" name="day" value="${k}"><input type="hidden" name="start" value="${t}"><button>${tstr(t)}</button></form>`).join("")}</div></div>`).join("")}</div>`
    : `<p class="note">No other open times in the next 3 weeks. Text us at (732) 206-7084 and we'll work something out.</p>`;
  const firstOf = await env.DB.prepare("SELECT * FROM memberships WHERE qualifying_booking = ? AND status IN ('pending','active') AND payments_made = 0").bind(b.id).first();
  const memWarn = firstOf ? `<p class="note" style="color:#ffd27a">This detail starts your Apex Membership (${h(planLabel(firstOf.type, firstOf.freq, firstOf.size))}). Cancelling it cancels the membership too. You won't be charged. Moving it to a new time keeps the membership and moves its first charge.</p>` : "";
  return page("Your booking", head + `<h2>Pick a new time</h2>${pick}<h2>Cancel</h2>${memWarn}<form method="post" action="/b/${b.token}/cancel" onsubmit="return confirm('${firstOf ? "Cancel this detail and your Apex Membership?" : "Cancel this detail?"}')"><button class="btn d" style="width:100%">Cancel my detail</button></form><p class="note">Free to change or cancel up to 24 hours before.</p>`);
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
    if (err.includes("location")) return json({ error: "We couldn't find that address. Pick it from the address suggestions, or pick your town from the list. Or text us at (732) 206-7084.", field: "q-town" }, 400);
    if (err.includes("distance")) return json({ error: "That address is too far for online booking. Text us at (732) 206-7084 and we'll see what we can do.", field: "q-town" }, 400);
    if (err.length) return json({ error: "Please check: " + err.join(", "), fields: err }, 400);
    // An email that already has an account: adding Apex Membership or a card on file needs that account's sign-in code,
    // so nobody can start a membership on someone else's saved card or replace it (audit IA-001 / IA-002).
    // The website asks for the code right in the booking form, then sends the booking again signed in.
    const session = await currentCustomer(env, req);
    const owner = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(normEmail(f.email)).first();
    if (owner && !(session && session.id === owner.id) && (f.plan || f.card))
      return json({ error: "This email already has an Apex account. Enter the code we email you to add Apex Membership or a card on file, or choose Pay in person.", needCode: true }, 403);
    const max = addDays(todayKey(), RULES.horizonDays);
    if (f.day > max) return json({ error: "That date is too far out." }, 400);
    if (!(await slotOpen(env, f.day, f.start, f.pkg, f.size, f.adds))) return json({ error: "Sorry, that time was just taken. Please pick another.", taken: true }, 409);
    // the server sets the price: launch price is for a customer's first detail only
    if (travelFee(f.miles) === null) return json({ error: "That address is too far for online booking. Text us at (732) 206-7084." }, 400);
    const prior = await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE email = ? AND status != 'cancelled'").bind(normEmail(f.email)).first();
    // members (signed in as this email) get their add-on discount (audit IA-004)
    const membership = session && owner && session.id === owner.id ? await activeFor(env, owner.id) : null;
    const q = priceQuote({ pkg: f.pkg, size: f.size, adds: f.adds, miles: f.miles, returning: prior.n > 0, member: !!membership });
    // the price on the customer's screen must match before we book (audit IA-003): if it doesn't, send back the real
    // price; the site shows it and books on the next tap with acceptPrice set to that price
    if (f.quote !== q.subtotal && Math.round(+body.acceptPrice || -1) !== q.subtotal)
      return json({ error: "Your price changed.", priceChanged: true, subtotal: q.subtotal, tax: q.tax, total: q.total, base: q.base, addTotal: q.addTotal, travel: q.travel, miles: f.miles,
        returning: prior.n > 0 && PRICING.launchSale, member: !!membership }, 409);
    const shownQuote = f.quote; f.quote = q.subtotal; f.travel_fee = q.travel;   // quote = price before tax (tax is added on the bill)
    const customerId = await upsertFromBooking(env, f, session && session.id);
    let bookingCard = null;
    if (f.card && f.cardToken && squareOn(env)) {
      const cust = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(customerId).first();
      try { const cd = await saveCard(env, cust, f.cardToken, f.postal); bookingCard = { id: cd.id, brand: cd.brand, last4: cd.last4 }; }
      catch (e) { return json({ error: e.message + " Or choose Pay in person.", card: true }, 402); }
    } else if (f.card && squareOn(env)) {
      // "use my saved card" only works when you're signed in as the owner of that card
      const cust = session && session.id === customerId ? await env.DB.prepare("SELECT card FROM customers WHERE id = ?").bind(customerId).first() : null;
      if (!cust || !cust.card) return json({ error: "Enter your card, or choose Pay in person.", card: true }, 400);
      const cd = JSON.parse(cust.card); bookingCard = { id: cd.id, brand: cd.brand, last4: cd.last4 };
    } else if (f.card && !squareOn(env)) f.card = 0;
    const start_utc = nyToUtc(f.day, f.start), end_utc = start_utc + jobMin(f.pkg, f.size, f.adds) * 60000;
    const b = { id: code(6), token: secret(), ack_token: secret(), status: "confirmed", created_at: Date.now(), start_utc, end_utc, day: f.day, pkg: f.pkg, size: f.size, adds: JSON.stringify(f.adds),
      plan: f.plan ? JSON.stringify(f.plan) : null, quote: f.quote, travel_fee: f.travel_fee, miles: f.miles, name: f.name, phone: f.phone, email: f.email, address: f.address, town: f.town,
      car: f.car, color: f.color, water: f.water, power: f.power, concerns: null, heard: f.heard, notes: f.notes, card_on_file: f.card, remind: f.remind, cal_href: null, customer_id: customerId, card: bookingCard ? JSON.stringify(bookingCard) : null,
      terms_version: TERMS_VERSION, terms_at: Date.now(), terms_ip: req.headers.get("CF-Connecting-IP") || "", sms_ok: f.sms ? 1 : 0, mem_auth_at: f.plan && f.memAuth ? Date.now() : null };
    await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, plan, quote, travel_fee, miles, name, phone, email, address, town, car, color, water, power, heard, notes, card_on_file, remind, customer_id, card, terms_version, terms_at, terms_ip, sms_ok, mem_auth_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.plan,
      b.quote, b.travel_fee, b.miles, b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.heard, b.notes, b.card_on_file, b.remind, b.customer_id, b.card, b.terms_version, b.terms_at, b.terms_ip, b.sms_ok, b.mem_auth_at).run();
    if (f.sms) await env.DB.prepare("UPDATE customers SET sms_ok = 1, sms_ok_at = ? WHERE id = ?").bind(Date.now(), customerId).run();
    if (f.plan && f.memAuth) {
      try { b._mem = await createMembership(env, { customerId, booking: b, type: f.plan.type, freq: f.plan.freq, auth: { version: TERMS_VERSION, at: Date.now(), ip: b.terms_ip } }); }
      catch (e) { b._memErr = e.message; }
    }
    // calendar + emails: don't let a hiccup there lose the booking
    const tasks = [];
    if (calConfigured(env)) tasks.push(calSave(env, b).catch(e => console.log("calendar save failed", e.message)));
    tasks.push(emailCustomer(env, b, "new").catch(e => console.log("customer email failed", e.message)));
    tasks.push(emailNick(env, b, "new").catch(e => console.log("nick email failed", e.message)));
    await Promise.all(tasks);
    return json({ ok: true, id: b.id, token: b.token, start: b.start_utc, end: b.end_utc, manage: env.SITE_URL + "/b/" + b.token,
      subtotal: q.subtotal, tax: q.tax, total: q.total, priceChanged: shownQuote !== q.subtotal, regularPricing: !q.launch && prior.n > 0, membership: b._mem || null, membershipError: b._memErr || null });
  }

  if (p === "/api/auth/start" && req.method === "POST") return authStart(req, env);
  if (p === "/api/auth/verify" && req.method === "POST") return authVerify(req, env);
  if (p === "/api/auth/logout" && req.method === "POST") return authLogout(req, env);
  if (p === "/api/me" && req.method === "GET") {
    const r = await me(req, env); if (r.status !== 200) return r;
    const j = await r.json(), c = await currentCustomer(env, req), m = await activeFor(env, c.id);
    j.member = await memSummary(env, m, c);
    // can they start a membership from the account? (within 14 days after a qualifying detail)
    if (!m) {
      const q = await qualifyingFor(env, c.id, todayKey());   // last 14 days, or an upcoming detail (audit IA-050)
      if (q) j.canStart = { booking: q.id, pkg: q.pkg, size: q.size, day: q.day, car: q.car, deadline: addDays(q.day, MEM.signupDays),
        plans: Object.keys(MEM.plans).filter(t => MEM.prereq[t].includes(q.pkg)), upcoming: q.day > todayKey(), firstBill: addMonths(q.day, 1) };
      if (j.canStart && !j.canStart.plans.length) delete j.canStart;
    }
    return json(j);
  }
  if (p === "/api/me") return me(req, env);
  if (p.startsWith("/api/member/")) return memberApi(req, env, url);
  if (p === "/api/config") return json({ square: publicConfig(env) });
  if (p === "/api/me/card") {
    const c = await currentCustomer(env, req); if (!c) return json({ error: "Sign in first." }, 401);
    if (req.method === "DELETE") {
      const mm = await activeFor(env, c.id);
      if (mm) return json({ error: "Your Apex Membership is billed to this card, so it can't be removed. You can replace it with another card." }, 409);
      await removeCard(env, c); return json({ ok: true });
    }
    if (req.method !== "POST" || !squareOn(env)) return json({ error: "Not available" }, 400);
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    try { const card = await saveCard(env, c, String(body.token || ""), String(body.postal || "").slice(0, 10)); return json({ ok: true, card: { brand: card.brand, last4: card.last4 } }); }
    catch (e) { return json({ error: e.message }, 402); }
  }
  if (p.startsWith("/api/pay/") && req.method === "POST") return payApi(req, env, url);

  if (p === "/api/status" && req.method === "GET") {
    const s = await lastSync(env);
    let cals = null;
    if (url.searchParams.get("cal") === "1" && calConfigured(env)) { try { cals = (await calendars(env, true)).map(c => c.name); } catch (e) { cals = "error: " + e.message; } }
    return json({ calendarConnected: calConfigured(env), emailConnected: !!env.RESEND_API_KEY, lastSync: s, calendars: cals });
  }

  return json({ error: "Not found" }, 404);
}

// ---------- Apex Membership (member actions) ----------
async function memberApi(req, env, url) {
  const c = await currentCustomer(env, req); if (!c) return json({ error: "Sign in first." }, 401);
  const action = url.pathname.split("/")[3];
  let body = {}; if (req.method === "POST") { try { body = await req.json(); } catch (e) {} }
  if (action === "start" && req.method === "POST") {
    if (body.auth !== true) return json({ error: "Please check the box to authorize the monthly charge." }, 400);
    if (!c.card) return json({ error: "Add a card first (My details → Payment card)." }, 400);
    const q = await qualifyingFor(env, c.id, todayKey());
    if (!q) return json({ error: "Memberships start with a detail: book one, or sign up within 14 days after it." }, 400);
    try { const r = await createMembership(env, { customerId: c.id, booking: q, type: String(body.type), freq: +body.freq, auth: { version: TERMS_VERSION, at: Date.now(), ip: req.headers.get("CF-Connecting-IP") || "" } });
      return json({ ok: true, message: "You're in! " + r.label + " at $" + r.monthly + "/mo + " + TAX.name + ". Your first charge (" + usd(withTax(r.monthly * 100).total) + ") is " + dayLabel(r.firstBill) + "." }); }
    catch (e) { return json({ error: e.message }, 400); }
  }
  const m = await activeFor(env, c.id); if (!m) return json({ error: "You don't have an active membership." }, 400);
  if (action === "slots") return json(await visitSlots(env, m, { days }));
  if (action === "visit" && req.method === "POST") {
    const day = String(body.day || ""), start = +body.start;
    const sl = await visitSlots(env, m, { days });
    const d = (sl.days || []).find(x => x.day === day);
    if (!d || !d.slots.includes(start)) return json({ error: sl.reason || "That time isn't available anymore. Pick another." }, 409);
    const pkg = MEM.visitPkg[coverOn(m.type, day)];
    if (!(await slotOpen(env, day, start, pkg, m.size, ["_member"]))) return json({ error: "That time was just taken. Pick another." }, 409);
    const last = await env.DB.prepare("SELECT * FROM bookings WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1").bind(c.id).first() || {};
    const cars = JSON.parse(c.cars || "[]"), car = m.car || (cars[0] && cars[0].name) || last.car || "";
    const start_utc = nyToUtc(day, start), end_utc = start_utc + jobMin(pkg, m.size, ["_member"]) * 60000;
    const b = { id: code(6), token: secret(), ack_token: secret(), status: "confirmed", created_at: Date.now(), start_utc, end_utc, day, pkg, size: m.size, adds: "[]", quote: 0, travel_fee: 0,
      name: c.name || last.name || "", phone: c.phone || last.phone || "", email: c.email, address: c.address || last.address || "", town: c.town || last.town || "", car, color: (cars[0] && cars[0].color) || last.color || "",
      water: last.water || null, power: last.power || null, notes: c.notes || null, remind: c.remind, customer_id: c.id, kind: "member", membership_id: m.id, visit_value_cents: m.period_visit_cents || 0 };
    await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, quote, travel_fee, name, phone, email, address, town, car, color, water, power, notes, remind, customer_id, kind, membership_id, visit_value_cents, terms_version, terms_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.quote, b.travel_fee,
      b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.notes, b.remind, b.customer_id, b.kind, b.membership_id, b.visit_value_cents, m.terms_version, Date.now()).run();
    const tasks = [];
    if (calConfigured(env)) tasks.push(calSave(env, b).catch(e => console.log("calendar save failed", e.message)));
    tasks.push(emailCustomer(env, b, "new").catch(() => {}), emailNick(env, b, "new").catch(() => {}));
    await Promise.all(tasks);
    return json({ ok: true, id: b.id, when: whenText(b) });
  }
  if (action === "cancel" && req.method === "POST") {
    try { return json(Object.assign({ ok: true }, await cancelMembership(env, m, String(body.mode || ""), c))); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (action === "pause" && req.method === "POST") {
    try { return json(Object.assign({ ok: true }, await pauseMembership(env, m, body.months))); } catch (e) { return json({ error: e.message }, 400); }
  }
  if (action === "retry" && req.method === "POST") {
    if (m.status !== "past_due") return json({ ok: true, message: "Nothing to retry." });
    const r = await retryNow(env, m); return json({ ok: /charged/.test(r), message: /charged/.test(r) ? "Paid. Thank you! You can book visits again." : "That card didn't work either. Try another card." });
  }
  return json({ error: "Not found" }, 404);
}

// the member's own copy of a skip (Nick gets his "Cancelled" email)
async function emailSkip(env, b, credit) {
  const first = (b.name || "").split(" ")[0] || "there", subject = "Skipped: your " + pkgName(b) + " on " + dayLabel(b.day);
  const body = `<h1 style="font-size:22px;margin:0 0 8px">Visit skipped</h1><p style="margin:0;color:#444;line-height:1.55">Hi ${h(first)}, we've skipped your ${h(pkgName(b))} on ${h(whenText(b))}. A skipped visit still counts as this month's visit. ` +
    (credit ? `You'll get a ${usd(credit)} credit (before tax) on your next monthly charge.` : `It was less than 48 hours' notice, so there's no credit for this one.`) + `</p><p style="margin:18px 0 0">${button(env.SITE_URL + "/#account", "My membership")}</p>`;
  return send(env, { to: b.email, subject, html: layout(subject, body, subject, env.SITE_URL + "/email-logo.png") });
}

// credit for a skipped member visit (customer: 50% with 48+ hours' notice; us/weather: 100%)
async function creditVisit(env, b, rate) {
  if (b.kind !== "member" || !b.membership_id || !rate) return 0;
  const credit = Math.round((b.visit_value_cents || 0) * rate);
  if (!credit) return 0;
  await env.DB.prepare("UPDATE bookings SET credit_cents = ? WHERE id = ?").bind(credit, b.id).run();
  await env.DB.prepare("UPDATE memberships SET credit_cents = credit_cents + ?, updated_at = ? WHERE id = ?").bind(credit, Date.now(), b.membership_id).run();
  return credit;
}
export async function cancelByUs(env, b) {
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
  b.status = "cancelled";
  const credit = await creditVisit(env, b, 1);
  if (b.kind !== "member") await cancelWithDetail(env, b, true).catch(e => console.log("membership cancel failed", e.message));
  await deleteJob(env, b.cal_href).catch(() => {});
  const first = b.name.split(" ")[0], subject = "We had to cancel your " + pkgName(b) + " on " + dayLabel(b.day);
  const body = `<h1 style="font-size:22px;margin:0 0 8px">Sorry, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">We had to cancel your ${h(pkgName(b))} on ${h(whenText(b))} (weather or something on our end). ` +
    (credit ? `We added a ${"$" + (credit / 100).toFixed(credit % 100 ? 2 : 0)} credit to your Apex Membership, and you can book a new time in your account.` : `Please pick a new time, or reply and we'll find one together.`) + `</p><p style="margin:18px 0 0">${button(env.SITE_URL + (b.kind === "member" ? "/#account" : "/#book"), "Pick a new time")}</p>`;
  await send(env, { to: b.email, subject, html: layout(subject, body, subject, env.SITE_URL + "/email-logo.png") }).catch(() => {});
  return credit;
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
  const desc = [b.name + " · " + b.phone, b.email, pkgName(b) + " · " + SIZES[b.size] + (adds.length ? " + " + adds.join(", ") : ""), [b.car, b.color].filter(Boolean).join(" · "),
    b.quote ? (e => "Estimate " + usd(e.sub) + " + " + usd(e.tax) + " tax = " + usd(e.total))(withTax(b.quote * 100)) : "", b.pkg === "interior" ? "Outlet: " + b.power : "Spigot: " + b.water + " · Outlet: " + b.power, b.notes ? "Notes: " + b.notes : "", "Code " + b.id, "Job done / get paid: " + env.SITE_URL + "/job/" + b.ack_token].filter(Boolean).join("\n");
  const href = await writeJob(env, b, { summary: pkgName(b) + " · " + b.name.split(" ")[0] + (b.town ? " · " + b.town : ""), location: where, description: desc, url: env.SITE_URL + "/job/" + b.ack_token });
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
  const hoursLeft = (b.start_utc - Date.now()) / 3600e3;
  if (hoursLeft < RULES.noticeHours && !(b.kind === "member" && m[2] === "cancel")) return html(await managePage(env, b, "It's too close to change online."));
  if (m[2] === "cancel") {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
    b.status = "cancelled";
    const credit = await creditVisit(env, b, hoursLeft >= MEM.skipNoticeHours ? MEM.skipCreditRate : 0);
    if (b.kind === "member") {
      await Promise.all([deleteJob(env, b.cal_href).catch(() => {}), emailNick(env, b, "cancel").catch(() => {}), emailSkip(env, b, credit).catch(() => {})]);
      return html(await managePage(env, b, credit ? "Skipped. A $" + (credit / 100).toFixed(credit % 100 ? 2 : 0) + " credit goes toward your next monthly charge." : "Skipped."));
    }
    await Promise.all([deleteJob(env, b.cal_href).catch(() => {}), emailCustomer(env, b, "cancel").catch(() => {}), emailNick(env, b, "cancel").catch(() => {})]);
    const memC = await cancelWithDetail(env, b, false).catch(e => { console.log("membership cancel failed", e.message); return null; });
    return html(await managePage(env, b, "Done." + (memC ? " Your Apex Membership was cancelled too. You weren't charged." : "")));
  }
  const fd = await req.formData(), day = String(fd.get("day") || ""), start = +fd.get("start");
  const adds = b.kind === "member" ? ["_member"] : JSON.parse(b.adds || "[]");
  if (b.kind === "member") {
    const mm = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(b.membership_id).first();
    const cv = mm && coverOn(mm.type, day);
    if (!mm || !cv || (mm.period_end && day >= mm.period_end)) return html(await managePage(env, b, "Pick a day in this month's period."));
    b.pkg = MEM.visitPkg[cv];
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(await slotOpen(env, day, start, b.pkg, b.size, adds, b.id))) return html(await managePage(env, b, "Sorry, that time was just taken. Pick another."));
  const was = whenText(b), start_utc = nyToUtc(day, start), end_utc = start_utc + jobMin(b.pkg, b.size, adds) * 60000;
  const hist = JSON.parse(b.history || "[]"); hist.push({ at: Date.now(), from: b.start_utc });
  await env.DB.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, day = ?, pkg = ?, history = ? WHERE id = ?").bind(start_utc, end_utc, day, b.pkg, JSON.stringify(hist), b.id).run();
  Object.assign(b, { start_utc, end_utc, day });
  if (b.kind !== "member") b._mem = await moveWithDetail(env, b).catch(e => { console.log("membership move failed", e.message); return null; });
  await Promise.all([calConfigured(env) ? calSave(env, b).catch(() => {}) : null, emailCustomer(env, b, "move").catch(() => {}), emailNick(env, b, "move", was).catch(() => {})]);
  return html(await managePage(env, b, "Moved. We sent you a new confirmation."));
}

async function ack(req, env, url) {
  const t = url.pathname.split("/")[2] || "";
  const b = /^[a-f0-9]{36}$/.test(t) ? await env.DB.prepare("SELECT * FROM bookings WHERE ack_token = ?").bind(t).first() : null;
  if (!b) return html(page("Not found", "<h1>Link not found</h1>"), 404);
  // only a tap on the button marks it seen; email link scanners open links with GET/HEAD
  if (req.method === "POST" && !b.acked_at) { b.acked_at = Date.now(); await env.DB.prepare("UPDATE bookings SET acked_at = ? WHERE id = ?").bind(b.acked_at, b.id).run(); }
  if (b.acked_at) return html(page("Got it", `<div class="ok">✓</div><h1>Got it</h1><p class="sub">${h(b.name)} · ${h(whenText(b))}</p>${summaryCard(b)}<div class="acts"><a class="btn g" href="/job/${b.ack_token}">Open the job page</a></div>`));
  return html(page("New booking", `<h1>${h(pkgName(b))} · ${h(b.name)}</h1><p class="sub">${h(whenText(b))}</p>${summaryCard(b)}<form method="post" class="acts"><button class="btn" style="width:100%">Got it</button></form><p class="note">"Got it" just marks it seen for you. The customer is already confirmed.</p>`));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin/")) {
        const who = await accessUser(req, env).catch(e => { console.log("admin auth error", e.message); return null; });
        if (!who) { console.log("admin denied", url.pathname); return url.pathname.startsWith("/api/") ? json({ error: "Not allowed" }, 403) : html(page("Not allowed", "<h1>Owner only</h1><p class='sub'>Sign in through Cloudflare Access to open the dashboard.</p>"), 403); }
        if (url.pathname.startsWith("/api/admin/")) return await adminApi(req, env, url, { syncBusy, pkgName });
        if (url.pathname === "/admin") return Response.redirect(url.origin + "/admin/", 302);
        const r = await env.ASSETS.fetch(req); const out = new Response(r.body, r); out.headers.set("Cache-Control", "no-store"); out.headers.set("X-Robots-Tag", "noindex"); return out;
      }
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname.startsWith("/b/")) return await manage(req, env, url);
      if (url.pathname.startsWith("/ack/") || url.pathname.startsWith("/job/")) {
        // owner-only pages: they can charge cards, mark jobs paid and cancel jobs (audit IA-034)
        const who = await accessUser(req, env).catch(e => { console.log("job auth error", e.message); return null; });
        if (!who) return html(page("Owner only", "<h1>Owner only</h1><p class='sub'>Sign in through Cloudflare Access to open this job.</p>"), 403);
        if (url.pathname.startsWith("/ack/")) return await ack(req, env, url);
        return await jobRoute(req, env, url, { page, summaryCard, whenText, cancelByUs, pkgName });
      }
      if (url.pathname.startsWith("/pay/")) return await payPage(req, env, url, { page, summaryCard, whenText });
    } catch (e) {
      console.log("error", e.stack || e.message);
      return url.pathname.startsWith("/api/") ? json({ error: "Something went wrong on our side. Please text (732) 206-7084." }, 500) : html(page("Error", "<h1>Something went wrong</h1><p class='sub'>Please text (732) 206-7084.</p>"), 500);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncBusy(env).then(r => console.log("sync", JSON.stringify(r))).catch(e => console.log("sync failed", e.message)));
    ctx.waitUntil(reminders(env).catch(e => console.log("reminders failed", e.message)));
    ctx.waitUntil(runBilling(env).then(l => l.length && console.log("billing", JSON.stringify(l))).catch(e => console.log("billing failed", e.message)));
  }
};

export { emailCustomer, emailNick };
