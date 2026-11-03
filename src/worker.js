// Apex Detailing — website + booking backend (Cloudflare Worker)
import { RULES, jobMin, dayInfo, slotsFor, nyToUtc, utcToNy, addDays, milesFromHome, milesBetween, parseDay, townCoords, inWinter } from "./sched.js";
import { calConfigured, readBusy, writeJob, deleteJob, calendars, jobIcs } from "./cal.js";
import { send, layout, rows, button, buttons, hero, para, note, heading, when, checklist, am, alertBox, sub, h } from "./email.js";
import { quote as priceQuote, travelFee, TAX, withTax, taxCents, PRICING } from "./pricing.js";
import { authStart, authVerify, authLogout, me, upsertFromBooking, normEmail, currentCustomer, emailCode } from "./accounts.js";
import { jobRoute, payPage, payApi, publicConfig, emailReceipt, emailPayLink } from "./pay.js";
import { squareOn, saveCard, removeCard } from "./square.js";
import { adminApi, accessUser, blockoutBusy } from "./admin.js";
import { loadSettings, publicSettings, settingsLoaded } from "./settings.js";
import { galleryRoute, purgeTrash } from "./photos.js";
import { syncSquare } from "./owner.js";
import { NO_SCENT, scentApplies, scentFor, scentList, pickScent, photoStart, setPhotoPref, photoPref, photoWords } from "./prefs.js";
import { MEM, createMembership, activeFor, summary as memSummary, visitSlots, runBilling, cancelMembership, pauseMembership, retryNow, coverOn, visitCover, startUpgrade, cancelUpgrade, addMonths, qualifyingFor, moveWithDetail, cancelWithDetail, planLabel, firstCharge, mailWelcome, previewMail, notifyNick } from "./membership.js";

const NAMES = { exterior: "Exterior", interior: "Interior", full: "Full Detail" };
const TERMS_VERSION = "2026-11-03";   // Nov 3: membership winter = the dates we set, upgrades (Membership Terms §6); Nov 2b: marketing photos are opt-out (Terms §10)   // bump when terms.html / membership-terms.html / privacy.html change
const SIZES = ["Sedan / Coupe", "SUV / Crossover", "Truck / 3-row"];
const VISIT_NAMES = { exterior: "Wash visit", interior: "Interior visit", full: "Wash + interior visit" };
const pkgName = b => b.kind === "member" ? VISIT_NAMES[b.pkg] : b.custom_name || NAMES[b.pkg];   // jobs Nick adds can have a custom package name
const ADDON_NAMES = { pet: "Heavy pet hair", stain: "Heavy stain or odor", lights: "Headlight restoration", engine: "Engine bay" };

const usd = c => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);   // cents -> "$244.17" / "$229"
const taxLabel = TAX.name + " (" + TAX.pct + ")";
// the membership line in booking emails: "Wash + interior, monthly (Sedan) · $95/mo + tax ($101.29). First charge Dec 1: $101.29"
// The first charge is shown the way billing will really make it (winter can skip Wash months or bill the Interior price).
const memLine = m => m.label + " · $" + m.monthly + "/mo + tax (" + usd(withTax(m.monthly * 100).total) + "). First charge " + dayLabel(m.firstBill) + ": " +
  usd(withTax(Math.round((m.firstAmount != null ? m.firstAmount : m.monthly) * 100)).total) + (m.firstSkipped ? " (no charges during the winter pause before that)" : m.firstWinter ? " (winter months are billed at the Interior price)" : "");
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
function realDay(k) { if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false; const { y, m, d } = parseDay(k), t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; }
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
function clean(v, max) { return String(v == null ? "" : v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max || 200); }

// ---------- abuse limits (audit IA-033) ----------
// Counts requests per key in D1. Off in local dev (RATE_LIMITS=off in .dev.vars) unless a test asks for them.
const ipOf = req => req.headers.get("CF-Connecting-IP") || "unknown";
const limitsOn = (env, req) => env.RATE_LIMITS !== "off" || req.headers.get("X-Apex-Ratetest") === "1";
async function overLimit(env, req, k, max, windowMs) {
  if (!limitsOn(env, req)) return false;
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM ratelog WHERE k = ? AND at > ?").bind(k, Date.now() - windowMs).first()).n;
  if (n >= max) return true;
  await env.DB.prepare("INSERT INTO ratelog (k, at) VALUES (?, ?)").bind(k, Date.now()).run();
  return false;
}
// Cloudflare Turnstile ("are you human"), only when Nick has added TURNSTILE_SITEKEY (var) and TURNSTILE_SECRET (secret)
async function humanOk(env, token, ip, host) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITEKEY) return true;
  if (!token || String(token).length > 2048) return false;
  const fd = new FormData(); fd.append("secret", env.TURNSTILE_SECRET); fd.append("response", String(token)); if (ip) fd.append("remoteip", ip);
  try {
    // local tests only (ADMIN_DEV is never set on the live Worker): point the check at a stand-in server
    const at = env.ADMIN_DEV === "1" && env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    const r = await fetch(at, { method: "POST", body: fd }); const j = await r.json();
    if (!j.success) { console.log("turnstile no", (j["error-codes"] || []).join(",")); return false; }
    if (host && j.hostname && j.hostname !== host) { console.log("turnstile wrong host", j.hostname, host); return false; }   // a token made on another site
    return true;
  } catch (e) { console.log("turnstile check failed", e.message); return false; }
}
const HUMAN_MSG = "We couldn't finish the quick \"are you human\" check. Tap the button again (if a checkbox shows up, tick it first), or text us at (732) 206-7084.";
// "Mar 1": the first day back from winter mode (Dashboard → Settings)
function winterBackText() { const e = RULES.winter.end; return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][e[0] - 1] + " " + e[1]; }
function readBooking(body) {
  const f = {
    pkg: clean(body.pkg, 20), size: +body.size, adds: Array.isArray(body.adds) ? body.adds.map(x => clean(x, 20)) : [],
    day: clean(body.day, 10), start: +body.start,
    name: clean(body.name, 80), phone: clean(body.phone, 30), email: clean(body.email, 120).toLowerCase(),
    address: clean(body.address, 160), town: clean(body.town, 60), car: clean(body.car, 80), color: clean(body.color, 30),
    water: clean(body.water, 5), power: clean(body.power, 5), notes: clean(body.notes, 1500), heard: clean(body.heard, 60),
    quote: Math.round(+body.quote || 0), travel_fee: 0, miles: null,   // the server works out distance and travel itself
    lat: body.lat == null ? null : +body.lat, lon: body.lon == null ? null : +body.lon,
    plan: body.plan && typeof body.plan === "object" && Object.hasOwn(MEM.plans, body.plan.type) ? { type: clean(body.plan.type, 10), freq: [1, 2, 4].includes(+body.plan.freq) ? +body.plan.freq : 1 } : null,
    card: body.card ? 1 : 0, remind: body.texts === false ? 0 : 1, cardToken: body.cardToken ? String(body.cardToken).slice(0, 400) : null, postal: clean(body.postal, 10),
    agree: body.agree === true, sms: body.sms === true, memAuth: body.memAuth === true, photosOptOut: body.photosOptOut === true || body.photosOptOut === "true" || body.photosOptOut === 1, scentIn: body.scent,
    key: /^[a-f0-9]{16,40}$/.test(String(body.key || "")) ? String(body.key) : null,
    // concern photos (already shrunk by the site): up to 4 JPEGs, emailed to Nick, not stored. Audit IA-016.
    photos: Array.isArray(body.photos) ? body.photos.slice(0, 4).map((x, i) => ({ filename: "concern-" + (i + 1) + ".jpg", data: String((x && x.data) || "") }))
      .filter(x => /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x.data) && x.data.length < 1500000).map(x => ({ filename: x.filename, content: x.data.slice(x.data.indexOf(",") + 1) })) : []
  };
  const err = [];
  if (!Object.hasOwn(NAMES, f.pkg)) err.push("package");
  if (![0, 1, 2].includes(f.size)) err.push("vehicle size");
  f.adds = [...new Set(f.adds)].filter(a => Object.hasOwn(RULES.addonPkgs, a) && RULES.addonPkgs[a].includes(f.pkg));
  if (!realDay(f.day) || !(f.start >= 0 && f.start < 1440)) err.push("time");
  if (f.name.length < 2) err.push("name");
  if (f.phone.replace(/\D/g, "").length < 10) err.push("phone");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) err.push("email");
  if (f.address.length < 4) err.push("address");
  if (f.pkg !== "interior" && f.water === "no") err.push("water spigot");
  if (f.power === "no") err.push("outlet");
  if (!f.agree) err.push("agreement to the Terms of Service");
  if (f.plan && !f.memAuth) err.push("membership charge authorization");
  const sc = pickScent(f.pkg, f.scentIn); if (sc.err) err.push("scent"); else f.scent = sc.scent;
  // distance comes from the address pin (or the town's center), never from the browser's number (audit IA-009)
  const pinOk = f.lat != null && f.lon != null && isFinite(f.lat) && isFinite(f.lon) && f.lat > 38 && f.lat < 42.5 && f.lon > -77 && f.lon < -72;
  const tc = townCoords(f.town), pin = pinOk ? [f.lat, f.lon] : tc;
  if (!pinOk) { f.lat = pin ? pin[0] : null; f.lon = pin ? pin[1] : null; }
  if (pin) f.miles = Math.round(milesFromHome(pin[0], pin[1]) * 10) / 10; else err.push("location");
  // the pin should be in the town they picked; if it isn't, charge travel by whichever is farther and tell Nick (review after the audit)
  if (pinOk && tc) {
    const gap = milesBetween(pin, tc);
    if (gap > 8) { f.miles = Math.max(f.miles, Math.round(milesFromHome(tc[0], tc[1]) * 10) / 10); f.locFlag = "The address pin is " + Math.round(gap) + " mi from " + f.town + ". Check the address and the travel fee."; }
  } else if (pinOk && !tc) f.locFlag = "\"" + (f.town || "No town") + "\" isn't on our town list. Check the address and the travel fee.";
  if (f.miles != null && f.miles > RULES.maxMiles) err.push("distance");
  return { f, err };
}

// ---------- emails ----------
// the booking's details (the date/time and address get their own block above these rows)
function details(b, site) {
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  const pr = b.kind === "member" ? [["Price", "Included in your " + am(site), true]] : priceRows(b), last = pr.length - 1;
  const m = b._mem, fa = m ? withTax(Math.round((m.firstAmount != null ? m.firstAmount : m.monthly) * 100)).total : 0;
  return [["Package", pkgName(b) + " · " + SIZES[b.size]], ["Add-ons", adds], ["Scent", b.scent || ""], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ...pr.map((r, i) => i === last && pr.length > 1 ? [r[0], h(String(r[1]).replace(/ · pay after the job$/, "")) + (/pay after the job$/.test(r[1]) ? sub("You pay after the job") : ""), true, "total"] : r),
    m ? [{ html: am(site) }, h(m.label) + sub("$" + m.monthly + "/mo + tax (" + usd(withTax(m.monthly * 100).total) + ")") + sub("First charge " + dayLabel(m.firstBill) + ": " + usd(fa) + (m.firstSkipped ? " (no charges during the winter pause before that)" : m.firstWinter ? " (winter months are billed at the Interior price)" : "")), true] : null,
    ["Booking code", b.id]].filter(Boolean);
}
function needsText(pkg) { return pkg === "interior" ? "an outlet we can reach (an indoor one is fine if we can run a cord outside)" : "an outdoor water spigot and an outlet we can reach"; }
function whenParts(b) { const s = utcToNy(b.start_utc), e = utcToNy(b.end_utc); return [dayLabel(s.key, true), tstr(s.min) + " – " + tstr(e.min)]; }

async function emailCustomer(env, b, kind) {
  const site = env.SITE_URL, manage = site + "/b/" + b.token;
  const ics = jobIcs(b, { summary: "Apex Detailing · " + pkgName(b), location: [b.address, b.town].filter(Boolean).join(", "), description: "Booking " + b.id + ". Manage: " + manage, url: manage });
  const first = (b.name || "").split(" ")[0] || "there", where = [b.address, b.town].filter(Boolean).join(", "), [day, time] = whenParts(b), pkg = pkgName(b);
  const member = b.kind === "member";
  let subject, top, pre;
  if (kind === "cancel") {
    subject = "Cancelled: your " + pkg + " on " + dayLabel(utcToNy(b.start_utc).key); pre = "Your booking is cancelled. Nothing was charged.";
    top = hero("Cancelled", "Your detail is cancelled.", `Hi ${h(first)}, we've cancelled your ${h(pkg)} on ${h(day)}. Nothing was charged. Whenever you're ready, we'd love to come back.`);
  } else if (kind === "move") {
    subject = "New time: " + pkg + " · " + whenText(b); pre = "You're all set for " + day + ", " + time + ".";
    top = hero("Rescheduled", "Your detail has a new time.", `Hi ${h(first)}, you're all set for the new time below. The calendar invite is updated too.`);
  } else if (kind === "remind") {
    subject = "Tomorrow: your " + pkg + " at " + tstr(utcToNy(b.start_utc).min); pre = "See you tomorrow at " + tstr(utcToNy(b.start_utc).min) + ".";
    top = hero("Tomorrow", `See you tomorrow, ${h(first)}.`, `A quick reminder about your ${h(pkg)}. Here's everything you need.`);
  } else {
    subject = "You're booked: " + pkg + " · " + whenText(b); pre = day + ", " + time + (b.town ? " in " + b.town : "") + ". Here are your details.";
    top = hero(member ? "Visit booked" : "Booking confirmed", `You're booked, ${h(first)}.`, member ? `Your ${h(pkg)} is on the calendar. It's included in your ${am(site)}.` : `Thanks for choosing Apex. We come to you, so there's nothing else to plan. Here's everything for your ${h(pkg)}.`);
  }
  let body = top + when(day, time, where ? h(where) : "");
  if (kind === "cancel") {
    body += rows([["Package", pkg + " · " + SIZES[b.size]], ["Booking code", b.id]]) + buttons([[site + "/#book", "Book again"]]);
  } else {
    body += rows(details(b, site)) +
      heading("Before we arrive") +
      checklist([`Make sure we have ${needsText(b.pkg)}.`, "Take valuables out of the car, and anything you don't want moved (car seats, gear in the trunk).", member ? "We'll walk the car with you when we're done." : "We confirm the final price before we start, never after. You pay when it's done and you've seen it."]) +
      buttons([[manage, "Manage booking"], kind === "remind" ? null : [site + "/#account", "My account", "secondary"]]) +
      note((kind === "remind" ? "Need to change it? Text us at (732) 206-7084." : "Free to reschedule or cancel up to 24 hours before. ") + (kind === "new" || kind === "move" ? "A calendar invite is attached." : "")) +
      (kind === "new" ? note(b.share_ok === 0 ? "Marketing photos: you opted out, so we won't feature your car."
        : b.share_ok == null ? `Can we feature before and after photos of your car (plate and address hidden)? <a href="${h(manage)}#photos" style="color:#f5f5f5">Tell us on your booking page</a>.`
        : `We may feature before and after photos of your car on our website and social media, with the plate and anything showing your address hidden. Prefer not? <a href="${h(manage)}#photos" style="color:#f5f5f5">Opt out on your booking page</a>.`) : "") +
      (kind === "new" && b._mem ? note(`About your ${am(site)}: it's billed to your card one month after this detail and on that date every month, plus NJ sales tax. ${MEM.minPayments}-month minimum, then pause or cancel anytime in your account. <a href="${h(site)}/membership-terms" style="color:#f5f5f5">Membership Terms</a>`) : "");
  }
  return send(env, {
    to: b.email, subject,
    html: layout(subject, body, pre, site),
    attachments: kind === "cancel" || kind === "remind" ? undefined : [{ filename: "apex-detail.ics", content: btoa(unescape(encodeURIComponent(ics))), content_type: "text/calendar" }]
  });
}

async function emailNick(env, b, kind, extra) {
  const site = env.SITE_URL, where = [b.address, b.town].filter(Boolean).join(", ");
  const maps = "https://maps.apple.com/?daddr=" + encodeURIComponent(where), tel = (b.phone || "").replace(/[^\d+]/g, "");
  const town = b.town || "", label = { new: "New booking", cancel: "Cancelled", move: "Rescheduled", scent: "Scent changed" }[kind];
  const subject = label + ": " + pkgName(b) + " · " + whenText(b) + (town ? " · " + town : "");
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  const [day, time] = whenParts(b);
  const list = [extra ? ["Was", extra] : null, ["Customer", `${h(b.name)}<br><a href="tel:${h(tel)}" style="color:#f5f5f5">${h(b.phone)}</a><br><a href="mailto:${h(b.email)}" style="color:#f5f5f5">${h(b.email)}</a>`, true],
    ["Package", pkgName(b) + " · " + SIZES[b.size]], ["Add-ons", adds], ["Scent", b.scent || ""], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Marketing photos", kind === "cancel" ? "" : photoWords(b)],
    ["Water / power", (b.pkg === "interior" ? "" : "Spigot: " + (b.water || "?") + " · ") + "Outlet: " + (b.power || "?")],
    ["Estimate", b.quote ? (e => usd(e.sub) + " + " + usd(e.tax) + " tax = " + usd(e.total))(withTax(b.quote * 100)) + (b.travel_fee ? " (incl. $" + b.travel_fee + " travel)" : "") : ""],
    ["Payment", b.kind === "member" ? "Apex Membership visit (included)" : b.card ? "Card on file: " + JSON.parse(b.card).brand + " ending " + JSON.parse(b.card).last4 + " (charge after the job)" : "In person"],
    [{ html: am(site) }, b._mem ? h("Signed up: " + memLine(b._mem)) : b._memErr ? h("Tried to sign up but: " + b._memErr) : "", true], ["Notes", b.notes], ["Heard about us", b.heard], ["Code", b.id]];
  const body = hero(label, h(pkgName(b) + " · " + (b.name || "")), "") +
    when(day, time, h(where) + (b.miles != null ? " · " + h(b.miles) + " mi" : "")) +
    (b._locFlag ? alertBox(h(b._locFlag)) : "") +
    buttons([kind === "cancel" ? null : [maps, "Directions", "secondary"], tel ? ["sms:" + tel, "Text", "secondary"] : null, tel ? ["tel:" + tel, "Call", "secondary"] : null], { inline: true }) +
    rows(list) +
    (kind === "new" ? buttons([[site + "/ack/" + b.ack_token, "Got it"], [site + "/admin/#job/" + b.id, "Open in dashboard", "secondary"]]) +
      note(`The customer is already confirmed. "Got it" just marks it seen. The job in your dashboard is where you take before and after photos, then charge their card, send a pay link or mark it paid in person. It's in your Apex Jobs calendar.`) : "") +
    (kind === "new" && b._photos && b._photos.length ? note(b._photos.length + " photo" + (b._photos.length > 1 ? "s" : "") + " of the areas of concern attached.") : "");
  const photos = kind === "new" && b._photos && b._photos.length ? b._photos : null;
  return send(env, { to: env.NICK_EMAIL, reply_to: b.email, subject, html: layout(subject, body, label + " · " + day + ", " + time, site, { who: "nick" }), attachments: photos || undefined });
}

// Two bookings saved at nearly the same moment for overlapping times: the later one steps back (audit IA-038).
async function lostRace(env, b) {
  const gap = RULES.gapMin * 60000;
  const other = await env.DB.prepare("SELECT id FROM bookings WHERE status = 'confirmed' AND id != ? AND start_utc < ? AND end_utc > ? AND (created_at < ? OR (created_at = ? AND id < ?)) LIMIT 1")
    .bind(b.id, b.end_utc + gap, b.start_utc - gap, b.created_at, b.created_at, b.id).first();
  return !!other;
}

// what /api/book answers once a booking exists (also for a repeated request with the same key)
// The answer for a booking that already exists (same key sent again). If the new request asked for something different
// (another time after a timeout, say), say so: the site shows the booking that really went through. Review after the audit.
async function bookedReply(env, b, f) {
  const t = withTax((b.quote || 0) * 100), m = await env.DB.prepare("SELECT * FROM memberships WHERE qualifying_booking = ? AND status != 'cancelled'").bind(b.id).first();
  const changed = !!f && (f.day !== b.day || f.start !== utcToNy(b.start_utc).min || f.pkg !== b.pkg || normEmail(f.email) !== normEmail(b.email));
  const fc = m ? firstCharge(m.type, m.size, m.freq, m.start_day) : null;
  return { ok: true, id: b.id, token: b.token, start: b.start_utc, end: b.end_utc, day: b.day, pkg: b.pkg, manage: env.SITE_URL + "/b/" + b.token, subtotal: b.quote, tax: t.tax / 100, total: t.total / 100, priceChanged: false, repeat: true, changed, scent: b.scent || null,
    membership: m ? { id: m.id, monthly: m.monthly_cents / 100, firstBill: fc.day, firstAmount: fc.amount, firstSkipped: fc.skipped, firstWinter: fc.winterPrice, label: planLabel(m.type, m.freq, m.size) } : null, membershipError: null };
}

// ---------- pages (manage booking / got it) ----------
function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)} · Apex Detailing</title><meta name="robots" content="noindex">
<style>:root{color-scheme:dark}html{background:#0a0a0a;min-height:100%}body{margin:0;background:#0a0a0a;min-height:100vh;color:#ededed;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.w{max-width:560px;margin:0 auto;padding:28px 16px 60px}.brand{font-weight:700;letter-spacing:.18em;font-size:13px;color:#bbb;text-decoration:none;display:inline-flex;align-items:center;gap:8px}
.brand svg{width:20px;height:20px}main{display:block}h1{font-size:28px;line-height:1.15;margin:22px 0 6px;letter-spacing:-.02em}.sub{color:#a3a3a3;margin:0 0 20px}
.card{background:rgba(255,255,255,.06);border-radius:20px;padding:6px 18px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.r{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid rgba(255,255,255,.08)}.r:last-child{border:0}.r span{color:#a3a3a3}.r b{text-align:right;font-weight:600}
.btn{display:inline-flex;justify-content:center;align-items:center;min-height:48px;padding:0 20px;border-radius:999px;border:0;background:#ededed;color:#0a0a0a;font-family:inherit;font-size:15px;font-weight:600;line-height:1;cursor:pointer;text-decoration:none}
.btn.g{background:rgba(255,255,255,.08);color:#ededed}.btn.d{background:transparent;color:#ff8a80;box-shadow:inset 0 0 0 1px rgba(255,138,128,.4)}
.acts{display:grid;gap:10px;margin-top:20px}h2{font-size:18px;margin:28px 0 10px}.days{display:grid;gap:14px}.day b{display:block;margin-bottom:8px}
.ts{display:flex;flex-wrap:wrap;gap:8px}.ts button{min-height:42px;padding:0 14px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:#ededed;font-family:inherit;font-size:14px;font-weight:600;cursor:pointer}
.ts button:hover{background:rgba(255,255,255,.16)}.note{color:#a3a3a3;font-size:14px}.ok{width:56px;height:56px;border-radius:50%;background:#ededed;color:#0a0a0a;display:grid;place-items:center;font-size:28px;margin-top:24px}
form{margin:0}.ts button[aria-pressed="true"]{background:#ededed;color:#0a0a0a}.r input[type=radio]{margin-right:8px}.btn:disabled{opacity:.5}</style></head><body><div class="w"><a class="brand" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 20 L10 6 L13 11 L15.5 8 L22 20 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.3 9 L10 6 L11.8 9.2 L10 8.4 Z" fill="currentColor"/></svg>APEX DETAILING</a><main>${inner}</main></div></body></html>`;
}

// plain-text rows for the site's own pages (manage, job, pay, Got it). Emails use details(), which returns HTML.
function pageRows(b) {
  const adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a).join(", ");
  return [["When", whenText(b)], ["Package", pkgName(b) + " · " + SIZES[b.size]], ["Add-ons", adds], ["Scent", b.scent || ""], ["Car", [b.car, b.color].filter(Boolean).join(" · ")],
    ["Where", [b.address, b.town].filter(Boolean).join(", ")], ...priceRows(b), b._mem ? ["Apex Membership", memLine(b._mem)] : null, ["Booking code", b.id]].filter(Boolean);
}
function summaryCard(b) {
  return `<div class="card">${pageRows(b).filter(r => r[1]).map(r => `<div class="r"><span>${h(r[0])}</span><b>${h(r[1])}</b></div>`).join("")}</div>`;
}

// jobs Nick set up by hand with their own package or length can't be moved online (the slot search uses package lengths)
const fixedLength = b => b.kind !== "member" && (!!b.custom_name || (b.source === "owner" && Math.round((b.end_utc - b.start_utc) / 60000) !== jobMin(b.pkg, b.size, JSON.parse(b.adds || "[]"))));
// a time button on the manage page: asks before moving (audit IA-025)
function moveForm(b, k, t) {
  const label = dayLabel(k, true) + " at " + tstr(t);
  return `<form method="post" action="/b/${b.token}/move" onsubmit="return confirm(${h(JSON.stringify("Move your " + pkgName(b) + " to " + label + "?"))})"><input type="hidden" name="day" value="${k}"><input type="hidden" name="start" value="${t}"><button aria-label="${h(label)}">${tstr(t)}</button></form>`;
}
// after a change, send the browser back to the page (so a refresh doesn't repeat it) with a message code
const MSGS = { moved: "Moved. We sent you a new confirmation.", cancelled: "Done.", cancelled_mem: "Done. Your Apex Membership was cancelled too. You weren't charged.", skipped: "Skipped.",
  scent: "Scent saved.", photos_on: "Thanks! We may feature your car (plate and address hidden).", photos_off: "Done. We won't feature photos of your car.",
  photos_signin: "You opted out of marketing photos for all your bookings. To change that, sign in to your account (My details) or text us at (732) 206-7084.", scent_busy: "Scent saved." };
const backTo = (b, code, extra) => new Response(null, { status: 303, headers: { Location: "/b/" + b.token + "?m=" + code + (extra || ""), "Cache-Control": "no-store" } });

async function managePage(env, b, msg) {
  const pics = b.photos_sent_at ? `<p class="note" style="margin-top:14px"><a class="btn g" style="width:100%" href="/b/${b.token}/photos">See your before &amp; after photos</a></p>` : "";
  return (await managePage0(env, b, msg)).replace("</main>", prefsHtml(b) + pics + "</main>");
}
const jobStarted = b => !!(b.started_at || b.completed_at) || Date.now() >= b.start_utc;
const SEL = "flex:1;min-width:0;min-height:48px;border-radius:12px;border:0;background:rgba(255,255,255,.08);color:#ededed;padding:0 12px;font:inherit;font-size:15px";
// the customer's scent and marketing-photo choices on their booking page
function prefsHtml(b) {
  if (b.status === "cancelled") return "";
  let out = "";
  if (scentFor(b) && !jobStarted(b)) {
    const cur = b.scent || NO_SCENT, opts = [NO_SCENT, ...scentList()];
    if (!opts.includes(cur)) opts.push(cur);
    out += `<h2 id="scent">Scent</h2><form method="post" action="/b/${b.token}/scent" style="display:flex;gap:8px"><select name="scent" aria-label="Scent" style="${SEL}">${opts.map(o => `<option${o === cur ? " selected" : ""}>${h(o)}</option>`).join("")}</select><button class="btn g">Save</button></form>` +
      `<p class="note">The scent we leave inside when we finish the interior. You can change it until we start.</p>`;
  }
  const off = b.share_ok === 0, asked = b.share_ok != null, form = (v, label, cls) => `<form method="post" action="/b/${b.token}/share" style="flex:1"><input type="hidden" name="back" value="manage"><button class="btn${cls}" name="ok" value="${v}" style="width:100%">${label}</button></form>`;
  out += `<h2 id="photos">Marketing photos</h2><p class="note">${!asked ? "Can we feature before and after photos of your car on our website and social media? We always hide the plate and anything that shows your address." : off ? "You opted out, so we won't feature photos of your car." : "We may feature before and after photos of your car on our website and social media. We always hide the plate and anything that shows your address."}</p>` +
    (!asked ? `<div style="display:flex;gap:8px">${form(1, "Yes, feature my car", "")}${form(0, "No thanks", " g")}</div>` : form(off ? 1 : 0, off ? "OK, you can feature my car" : "Opt out of marketing photos", " g"));
  return out;
}
async function managePage0(env, b, msg) {
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
    for (const k of Object.keys(info)) { if (member.period_end && k >= member.period_end) break; const cv = visitCover(member, k); if (!cv) continue; const sl = slotsFor(k, info[k], MEM.visitPkg[cv], b.size, ["_member"], Date.now()).filter(t => !(k === b.day && t === utcToNy(b.start_utc).min)); if (sl.length) opts.push([k, sl]); if (opts.length >= 8) break; }
    const pick = opts.length ? `<div class="days">${opts.map(([k, sl]) => `<div class="day"><b>${h(dayLabel(k, true))}</b><div class="ts">${sl.slice(0, 8).map(t => moveForm(b, k, t)).join("")}</div></div>`).join("")}</div>` : `<p class="note">No other open times left in this month's period.</p>`;
    return page("Your visit", head + `<h2>Pick a new time</h2>${pick}${skip}`);
  }
  if (hoursLeft < RULES.noticeHours) return page("Your booking", head + `<p class="note" style="margin-top:18px">It's less than 24 hours away, so changes go through us directly: text or call <a href="sms:7322067084" style="color:#ededed">(732) 206-7084</a>.</p>`);
  if (fixedLength(b)) return page("Your booking", head + `<p class="note" style="margin-top:18px">To change or cancel this job, text or call us at <a href="sms:7322067084" style="color:#ededed">(732) 206-7084</a>.</p>`);
  // next open times for the same job (next 21 days), excluding this booking itself
  const adds = JSON.parse(b.adds || "[]"), start = addDays(todayKey(), 1), info = await days(env, start, 21, b.id), opts = [];
  for (const k of Object.keys(info)) { const s = slotsFor(k, info[k], b.pkg, b.size, adds, Date.now()).filter(t => !(k === b.day && t === utcToNy(b.start_utc).min)); if (s.length) opts.push([k, s]); if (opts.length >= 8) break; }
  const coldDays = b.pkg !== "interior" && Object.keys(info).some(k => (d => inWinter(d.y, d.m, d.d))(parseDay(k)));
  const pick = opts.length ? `<div class="days">${opts.map(([k, s]) => `<div class="day"><b>${h(dayLabel(k, true))}</b><div class="ts">${s.slice(0, 8).map(t => moveForm(b, k, t)).join("")}</div></div>`).join("")}</div>`
    : coldDays ? `<p class="note">It's winter, so ${b.pkg === "full" ? "Full Details" : "Exterior details"} can't be moved to a new date online until ${winterBackText()} (it's too cold to wash outside: water freezes on the paint and sealant won't cure). Text us at (732) 206-7084 and we'll work it out, or switch it to an Interior.</p>`
    : `<p class="note">No other open times in the next 3 weeks. Text us at (732) 206-7084 and we'll work something out.</p>`;
  const firstOf = await env.DB.prepare("SELECT * FROM memberships WHERE qualifying_booking = ? AND status IN ('pending','active') AND payments_made = 0").bind(b.id).first();
  const memWarn = firstOf ? `<p class="note" style="color:#ffd27a">This detail starts your Apex Membership (${h(planLabel(firstOf.type, firstOf.freq, firstOf.size))}). Cancelling it cancels the membership too. You won't be charged. Moving it to a new time keeps the membership and moves its first charge.</p>` : "";
  return page("Your booking", head + `<h2>Pick a new time</h2>${pick}<h2>Cancel</h2>${memWarn}<form method="post" action="/b/${b.token}/cancel" onsubmit="return confirm('${firstOf ? "Cancel this detail and your Apex Membership?" : "Cancel this detail?"}')"><button class="btn d" style="width:100%">Cancel my detail</button></form><p class="note">Free to change or cancel up to 24 hours before.</p>`);
}

// ---------- routes ----------
async function api(req, env, url) {
  const p = url.pathname;
  // local preview of every email with sample data (never on the real site: needs ADMIN_DEV=1 and localhost)
  if (p === "/api/dev/emails" && env.ADMIN_DEV === "1" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return json(await devEmails(env));

  if (p === "/api/days" && req.method === "GET") {
    const fq = url.searchParams.get("from") || "", from = realDay(fq) && fq >= addDays(todayKey(), -1) ? fq : todayKey();
    const n = Math.min(70, Math.max(1, +url.searchParams.get("n") || 45));
    const s = await lastSync(env);
    return json({ now: Date.now(), rules: { startMin: RULES.startMin, gapMin: RULES.gapMin, noticeHours: RULES.noticeHours, minDaysAhead: RULES.minDaysAhead, stepMin: RULES.stepMin, maxJobs: RULES.maxJobs, maxJobsDayOff: RULES.maxJobsDayOff, horizonDays: RULES.horizonDays },
      calendar: calConfigured(env) ? (s ? "synced" : "pending") : "not-connected", syncedAt: s && s.at, days: await days(env, from, n) });
  }

  if (p === "/api/book" && req.method === "POST") {
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Bad request" }, 400);
    if (body.website) return json({ ok: true, id: "OK" });   // spam trap
    if (await overLimit(env, req, "book:" + ipOf(req), 10, 3600e3)) return json({ error: "Too many booking tries from your connection. Try again in an hour, or text us at (732) 206-7084." }, 429);
    const { f, err } = readBooking(body);
    // the same booking sent again (lost response, timeout, double tap): answer with the one already made. Audit IA-011.
    if (f.key) { const ex = await env.DB.prepare("SELECT * FROM bookings WHERE client_key = ?").bind(f.key).first(); if (ex) return json(await bookedReply(env, ex, f)); }
    if (err.includes("location")) return json({ error: "We couldn't find that address. Pick it from the address suggestions, or pick your town from the list. Or text us at (732) 206-7084.", field: "q-town" }, 400);
    if (err.includes("distance")) return json({ error: "That address is too far for online booking. Text us at (732) 206-7084 and we'll see what we can do.", field: "q-town" }, 400);
    if (err.includes("scent")) return json({ error: "That scent isn't offered anymore. Pick another scent.", field: "scent", scents: scentList() }, 400);
    if (err.length) return json({ error: "Please check: " + err.join(", "), fields: err }, 400);
    if (!(await humanOk(env, body.ts, ipOf(req), url.hostname))) return json({ error: HUMAN_MSG, needHuman: true }, 403);
    if (limitsOn(env, req)) {   // at most 3 upcoming details per email and per phone number
      const digits = f.phone.replace(/\D/g, "").slice(-10);
      const up = await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE status = 'confirmed' AND kind != 'member' AND end_utc > ? AND (email = ? OR substr(replace(replace(replace(replace(replace(phone,'(',''),')',''),' ',''),'-',''),'+',''), -10) = ?)").bind(Date.now(), normEmail(f.email), digits).first();
      if (up.n >= 3) return json({ error: "You already have 3 upcoming details booked. Text us at (732) 206-7084 to add another." }, 429);
    }
    if (nyToUtc(f.day, f.start) < Date.now() + RULES.noticeHours * 3600e3) return json({ error: "That time is less than " + RULES.noticeHours + " hours away or has passed. Please pick another time.", taken: true }, 409);
    const soonest = addDays(todayKey(), RULES.minDaysAhead || 1);   // a full day's notice (Settings → Earliest booking)
    if (f.day < soonest) return json({ error: "We need a little notice to fit you in: the earliest you can book online is " + dayLabel(soonest, true) + ". For anything sooner, text us at (732) 206-7084.", taken: true }, 409);
    // An email that already has an account: adding Apex Membership or a card on file needs that account's sign-in code,
    // so nobody can start a membership on someone else's saved card or replace it (audit IA-001 / IA-002).
    // The website asks for the code right in the booking form, then sends the booking again signed in.
    const session = await currentCustomer(env, req);
    const owner = await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(normEmail(f.email)).first();
    if (owner && !(session && session.id === owner.id) && (f.plan || f.card))
      return json({ error: "This email already has an Apex account. Enter the code we email you to add Apex Membership or a card on file, or choose Pay in person.", needCode: true }, 403);
    const max = addDays(todayKey(), RULES.horizonDays);
    if (f.day > max) return json({ error: "That date is too far out." }, 400);
    if (f.pkg !== "interior" && (d => inWinter(d.y, d.m, d.d))(parseDay(f.day))) {   // winter mode: say why, not "taken"
      return json({ error: "It's winter, so we only do Interior details until " + winterBackText() + ": it's too cold to wash outside (water freezes on the paint and sealant won't cure). Pick an Interior, or check back closer to " + winterBackText() + " for an outside detail.", winter: true }, 409);
    }
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
      catch (e) {
        // a declined card shouldn't leave a brand-new account with no booking behind (audit IA-021i)
        if (!owner) await env.DB.prepare("DELETE FROM customers WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bookings WHERE customer_id = ?)").bind(customerId, customerId).run().catch(() => {});
        return json({ error: e.message + " Or choose Pay in person.", card: true }, 402);
      }
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
      terms_version: TERMS_VERSION, terms_at: Date.now(), terms_ip: req.headers.get("CF-Connecting-IP") || "", sms_ok: f.sms ? 1 : 0, mem_auth_at: f.plan && f.memAuth ? Date.now() : null, client_key: f.key,
      scent: f.scent || null, ...(await photoStart(env, customerId, f.email, { optOut: f.photosOptOut, agreed: true, trusted: !owner || !!(session && session.id === owner.id) })) };
    try {
      await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, plan, quote, travel_fee, miles, name, phone, email, address, town, car, color, water, power, heard, notes, card_on_file, remind, customer_id, card, terms_version, terms_at, terms_ip, sms_ok, mem_auth_at, client_key, scent, share_ok, share_at, share_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.plan,
        b.quote, b.travel_fee, b.miles, b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.heard, b.notes, b.card_on_file, b.remind, b.customer_id, b.card, b.terms_version, b.terms_at, b.terms_ip, b.sms_ok, b.mem_auth_at, b.client_key,
        b.scent, b.share_ok, b.share_at, b.share_by).run();
    } catch (e) {   // two copies of the same request at once: the other one won, answer with it
      const ex = f.key && await env.DB.prepare("SELECT * FROM bookings WHERE client_key = ?").bind(f.key).first();
      if (ex) return json(await bookedReply(env, ex, f));
      throw e;
    }
    if (await lostRace(env, b)) {
      await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(b.id).run();
      return json({ error: "Sorry, that time was just taken. Please pick another.", taken: true }, 409);
    }
    b._photos = f.photos; b._locFlag = f.locFlag || null;
    // texting consent goes on the account only for a new account or when signed in as its owner (the booking keeps its own sms_ok)
    if (f.sms && (!owner || (session && session.id === owner.id))) await env.DB.prepare("UPDATE customers SET sms_ok = 1, sms_ok_at = ? WHERE id = ?").bind(Date.now(), customerId).run();
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
    return json({ ok: true, id: b.id, token: b.token, start: b.start_utc, end: b.end_utc, day: b.day, pkg: b.pkg, manage: env.SITE_URL + "/b/" + b.token,
      subtotal: q.subtotal, tax: q.tax, total: q.total, priceChanged: shownQuote !== q.subtotal, scent: b.scent || null, regularPricing: !q.launch && prior.n > 0, membership: b._mem || null, membershipError: b._memErr || null });
  }

  if (p === "/api/auth/start" && req.method === "POST") {
    if (await overLimit(env, req, "auth:" + ipOf(req), 10, 600e3)) return json({ error: "Too many code requests from your connection. Try again in 10 minutes." }, 429);
    const pre = await req.clone().json().catch(() => null);
    if (!(await humanOk(env, pre && pre.ts, ipOf(req), url.hostname))) return json({ error: HUMAN_MSG, needHuman: true }, 403);
    return authStart(req, env);
  }
  if (p === "/api/auth/verify" && req.method === "POST") {
    if (await overLimit(env, req, "verify:" + ipOf(req), 30, 600e3)) return json({ error: "Too many tries from your connection. Try again in 10 minutes." }, 429);
    return authVerify(req, env);
  }
  if (p === "/api/auth/logout" && req.method === "POST") return authLogout(req, env);
  if (p === "/api/me" && req.method === "GET") {
    const r = await me(req, env); if (r.status !== 200) return r;
    const j = await r.json(); if (!j.signedIn) return json(j);   // signed out: a normal answer, not an error (audit IA-059)
    const c = await currentCustomer(env, req), m = await activeFor(env, c.id);
    j.member = await memSummary(env, m, c);
    const pp = await photoPref(env, c.id, c.email);   // marketing photos: OK unless they opted out (Terms §10)
    j.photos = { ok: pp ? !!pp.ok : null, by: pp ? pp.by : null };   // null: never answered
    const ls = await env.DB.prepare("SELECT scent FROM bookings WHERE customer_id = ? AND scent IS NOT NULL ORDER BY created_at DESC LIMIT 1").bind(c.id).first();
    j.lastScent = ls ? ls.scent : null;
    // can they start a membership from the account? (within 14 days after a qualifying detail)
    if (!m) {
      const q = await qualifyingFor(env, c.id, todayKey());   // last 14 days, or an upcoming detail (audit IA-050)
      if (q) j.canStart = { booking: q.id, pkg: q.pkg, size: q.size, day: q.day, car: q.car, deadline: addDays(q.day, MEM.signupDays),
        plans: Object.keys(MEM.plans).filter(t => MEM.prereq[t].includes(q.pkg)), upcoming: q.day > todayKey(), firstBill: addMonths(q.day, 1) };
      if (j.canStart && !j.canStart.plans.length) delete j.canStart;
      // the first charge exactly as billing will make it, per plan and frequency (the Terms' winter can skip months or change the price)
      if (j.canStart) j.canStart.first = Object.fromEntries(j.canStart.plans.map(t => [t, Object.fromEntries([1, 2, 4].map(fq => [fq, (x => ({ day: x.day, amount: x.amount, skipped: x.skipped, winterPrice: x.winterPrice }))(firstCharge(t, q.size, fq, q.day))]))]));
    }
    return json(j);
  }
  if (p === "/api/me/photos" && req.method === "POST") {   // the account's marketing-photo switch (all their bookings)
    const o = req.headers.get("Origin"); if (o && o !== url.origin) return json({ error: "Not allowed" }, 403);
    const c = await currentCustomer(env, req); if (!c) return json({ error: "Sign in first." }, 401);
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (typeof body.ok !== "boolean") return json({ error: "Bad request" }, 400);
    await setPhotoPref(env, { id: "", customer_id: c.id, email: c.email }, body.ok, "account");
    return json({ ok: true, photos: { ok: body.ok, by: "customer" } });
  }
  if (p === "/api/me") return me(req, env);
  if (p.startsWith("/api/member/")) return memberApi(req, env, url);
  if (p === "/api/config") return json({ square: publicConfig(env), turnstile: env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY ? env.TURNSTILE_SITEKEY : null });
  if (p === "/api/me/card") {
    const c = await currentCustomer(env, req); if (!c) return json({ error: "Sign in first." }, 401);
    if (req.method === "DELETE") {
      const mm = await activeFor(env, c.id);
      if (mm) return json({ error: "Your Apex Membership is billed to this card, so it can't be removed. You can replace it with another card." }, 409);
      await removeCard(env, c); return json({ ok: true });
    }
    if (req.method !== "POST" || !squareOn(env)) return json({ error: "Not available" }, 400);
    // card checks cost money and attract card testers: a few per customer per day, a few per connection per hour (review after the audit)
    if (await overLimit(env, req, "card:" + c.id, 3, 86400e3) || await overLimit(env, req, "cardip:" + ipOf(req), 5, 3600e3))
      return json({ error: "Too many card changes for now. Try again tomorrow, or text us at (732) 206-7084." }, 429);
    let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    try { const card = await saveCard(env, c, String(body.token || ""), String(body.postal || "").slice(0, 10)); return json({ ok: true, card: { brand: card.brand, last4: card.last4 } }); }
    catch (e) { return json({ error: e.message }, 402); }
  }
  if (p.startsWith("/api/pay/") && req.method === "POST") return payApi(req, env, url);

  // (the old public /api/status moved to /api/admin/status, behind Cloudflare Access: audit IA-035)

  if (["/api/days", "/api/book", "/api/auth/start", "/api/auth/verify", "/api/auth/logout", "/api/config"].includes(p)) return json({ error: "Method not allowed" }, 405);
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
      await mailWelcome(env, r.id, r, c.card ? JSON.parse(c.card) : null).catch(e => console.log("welcome email failed", e.message));
      return json({ ok: true, message: "You're in! " + r.label + " at $" + r.monthly + "/mo + " + TAX.name + ". Your first charge (" + usd(withTax(Math.round((r.firstAmount != null ? r.firstAmount : r.monthly) * 100)).total) + ") is " + dayLabel(r.firstBill) + "." }); }
    catch (e) { return json({ error: e.message }, 400); }
  }
  const m = await activeFor(env, c.id); if (!m) return json({ error: "You don't have an active membership." }, 400);
  if (action === "slots") return json(await visitSlots(env, m, { days }));
  if (action === "visit" && req.method === "POST") {
    const day = String(body.day || ""), start = +body.start;
    const sl = await visitSlots(env, m, { days });
    const d = (sl.days || []).find(x => x.day === day);
    if (!d || !d.slots.includes(start)) return json({ error: sl.reason || "That time isn't available anymore. Pick another." }, 409);
    const pkg = MEM.visitPkg[visitCover(m, day)];
    const sc = pickScent(pkg, body.scent); if (sc.err) return json({ error: sc.err, field: "scent", scents: scentList() }, 400);
    if (!(await slotOpen(env, day, start, pkg, m.size, ["_member"]))) return json({ error: "That time was just taken. Pick another." }, 409);
    const last = await env.DB.prepare("SELECT * FROM bookings WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1").bind(c.id).first() || {};
    const cars = JSON.parse(c.cars || "[]"), car = m.car || (cars[0] && cars[0].name) || last.car || "";
    const start_utc = nyToUtc(day, start), end_utc = start_utc + jobMin(pkg, m.size, ["_member"]) * 60000;
    const b = { id: code(6), token: secret(), ack_token: secret(), status: "confirmed", created_at: Date.now(), start_utc, end_utc, day, pkg, size: m.size, adds: "[]", quote: 0, travel_fee: 0,
      name: c.name || last.name || "", phone: c.phone || last.phone || "", email: c.email, address: c.address || last.address || "", town: c.town || last.town || "", car, color: (cars[0] && cars[0].color) || last.color || "",
      water: last.water || null, power: last.power || null, notes: c.notes || null, remind: c.remind, customer_id: c.id, kind: "member", membership_id: m.id, visit_value_cents: m.period_visit_cents || 0,
      scent: sc.scent, ...(await photoStart(env, c.id, c.email, { optOut: false, agreed: true, trusted: true })) };
    await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, quote, travel_fee, name, phone, email, address, town, car, color, water, power, notes, remind, customer_id, kind, membership_id, visit_value_cents, terms_version, terms_at, scent, share_ok, share_at, share_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.quote, b.travel_fee,
      b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.notes, b.remind, b.customer_id, b.kind, b.membership_id, b.visit_value_cents, m.terms_version, Date.now(), b.scent, b.share_ok, b.share_at, b.share_by).run();
    if (await lostRace(env, b)) { await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(b.id).run(); return json({ error: "That time was just taken. Pick another." }, 409); }
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
  if (action === "upgrade" && req.method === "POST") {   // Interior → Wash + interior after an Exterior Detail (Membership Terms §6)
    const o = req.headers.get("Origin"); if (o && o !== url.origin) return json({ error: "Not allowed" }, 403);
    try {
      if (await overLimit(env, req, "upgrade:" + m.id, 6, 86400e3)) return json({ error: "Too many changes today. Text us at (732) 206-7084." }, 429);   // each one emails the member and Nick
      if (body.cancel === true) return json(Object.assign({ ok: true }, await cancelUpgrade(env, m)));
      if (body.auth !== true) return json({ error: "Please check the box to authorize the new monthly price." }, 400);
      return json(Object.assign({ ok: true }, await startUpgrade(env, m, c, { version: TERMS_VERSION, at: Date.now(), ip: req.headers.get("CF-Connecting-IP") || "" })));
    } catch (e) { return json({ error: e.message }, 400); }
  }
  if (action === "retry" && req.method === "POST") {
    if (m.status !== "past_due") return json({ ok: true, message: "Nothing to retry." });
    const r = await retryNow(env, m); return json({ ok: /charged/.test(r), message: /charged/.test(r) ? "Paid. Thank you! You can book visits again." : "That card didn't work either. Try another card." });
  }
  return json({ error: "Not found" }, 404);
}

// the member's own copy of a skip (Nick gets his "Cancelled" email)
async function emailSkip(env, b, credit) {
  const site = env.SITE_URL, first = (b.name || "").split(" ")[0] || "there", subject = "Skipped: your " + pkgName(b) + " on " + dayLabel(b.day);
  const [day, time] = whenParts(b);
  const body = hero("Visit skipped", "Your visit is skipped.", `Hi ${h(first)}, we've skipped your ${h(pkgName(b))}. A skipped visit still counts as this month's visit.`) +
    when(day, time, "Skipped") +
    para(credit ? `You'll get a <b style="color:#f5f5f5">${usd(credit)} credit</b> (before tax) on your next monthly charge.` : `It was less than 48 hours' notice, so there's no credit for this one.`) +
    buttons([[site + "/#account", "My membership"]]);
  return send(env, { to: b.email, subject, html: layout(subject, body, credit ? "A " + usd(credit) + " credit goes toward your next charge." : "Your visit is skipped.", site) });
}
// we had to cancel (weather or our side)
async function emailCancelByUs(env, b, credit) {
  const site = env.SITE_URL, first = (b.name || "").split(" ")[0] || "there", subject = "We had to cancel your " + pkgName(b) + " on " + dayLabel(b.day);
  const [day, time] = whenParts(b);
  const body = hero("Cancelled", `Sorry, ${h(first)}. We had to cancel.`, `Weather or something on our end means we can't make your ${h(pkgName(b))}. Nothing was charged.`) +
    when(day, time, "Cancelled") +
    para(credit ? `We added a <b style="color:#f5f5f5">${usd(credit)} credit</b> to your ${am(site)}. Pick a new time in your account whenever you're ready.` : `Pick a new time that works for you, or just reply and we'll find one together.`) +
    buttons([[site + (b.kind === "member" ? "/#account" : "/#book"), "Pick a new time"]]);
  return send(env, { to: b.email, subject, html: layout(subject, body, "Sorry about this. Let's find you a new time.", site) });
}

// every email the site can send, built with sample data (local preview only)
async function devEmails(env) {
  const out = [], add = async (key, label, fn) => { const cap = []; const E = Object.assign({}, env, { __capture: cap }); try { await fn(E); } catch (e) { out.push({ key, label, error: e.message }); return; } cap.forEach((m, i) => out.push({ key: key + (i ? "-" + i : ""), label, to: m.to, subject: m.subject, html: m.html, text: m.text, attachments: (m.attachments || []).map(a => a.filename) })); };
  const day = addDays(todayKey(), 6), t0 = nyToUtc(day, 600);
  const base = { id: "Q9FE6T", token: "a".repeat(36), ack_token: "b".repeat(36), pay_token: "c".repeat(36), status: "confirmed", name: "Jordan Rivera", email: "jordan@example.com", phone: "(732) 555-0142",
    pkg: "full", size: 1, adds: '["pet"]', car: "2021 Toyota RAV4", color: "Red", address: "12 Shore Rd", town: "Brick", day, start_utc: t0, end_utc: t0 + 300 * 60000, quote: 209, travel_fee: 0,
    water: "yes", power: "yes", notes: "Coffee stain on the passenger seat", heard: "Instagram", kind: "detail", miles: 3.2, card: JSON.stringify({ brand: "Visa", last4: "4242" }) };
  const B = o => Object.assign({}, base, o || {});
  const mem = { label: "Wash + interior, monthly (SUV)", monthly: 105, firstBill: addDays(day, 30), firstAmount: 105 };
  const visit = B({ kind: "member", pkg: "interior", quote: 0, adds: "[]", membership_id: "m1", card: null });
  const M = { id: "m1", customer_id: "c1", type: "both", freq: 1, size: 1, monthly_cents: 10500, email: "jordan@example.com", name: "Jordan Rivera", status: "active", payments_made: 1 };
  const card = { brand: "Visa", last4: "4242" };
  await add("code", "Sign-in code", E => emailCode(E, "jordan@example.com", "482917"));
  await add("booked", "Booking confirmed (with Apex Membership)", E => emailCustomer(E, B({ _mem: mem }), "new"));
  await add("booked-visit", "Member visit booked", E => emailCustomer(E, visit, "new"));
  await add("moved", "Rescheduled", E => emailCustomer(E, B(), "move"));
  await add("remind", "Day-before reminder", E => emailCustomer(E, B(), "remind"));
  await add("cancelled", "Cancelled by the customer", E => emailCustomer(E, B(), "cancel"));
  await add("cancel-by-us", "We had to cancel (weather)", E => emailCancelByUs(E, B(), 0));
  await add("cancel-by-us-member", "We had to cancel a member visit (credit)", E => emailCancelByUs(E, visit, 4250));
  await add("skip", "Member visit skipped (credit)", E => emailSkip(E, visit, 2125));
  await add("pay-link", "Job done: pay link", E => emailPayLink(E, B(), 22900, taxCents(22900)));
  await add("receipt-card", "Receipt: card on file (tip offer)", E => emailReceipt(E, B(), { amount: 22900, tax: taxCents(22900), method: "Visa ending 4242", receipt: "https://squareup.com/receipt/preview/sample", offerTip: true }));
  await add("receipt-online", "Receipt: paid online with a tip", E => emailReceipt(E, B(), { amount: 22900, tax: taxCents(22900), tip: 4600, method: "Visa ending 4242", receipt: "https://squareup.com/receipt/preview/sample" }));
  await add("receipt-person", "Receipt: paid in person", E => emailReceipt(E, B(), { amount: 20000, tax: taxCents(20000), method: "In person (cash)" }));
  await add("tip", "Tip thank-you", E => emailReceipt(E, B(), { tipOnly: true, tip: 4000, method: "Visa ending 4242", receipt: "https://squareup.com/receipt/preview/sample" }));
  const mk = (kind, o) => E => previewMail(E, M, kind, o);
  await add("mem-welcome", "Membership: welcome (started from the account)", mk("welcome", { firstBill: mem.firstBill, firstAmount: 105, card }));
  await add("mem-receipt", "Membership: monthly receipt", mk("receipt", { amount: 10500, tax: taxCents(10500), period: [day, addDays(day, 30)], cover: "both", card, receipt: "https://squareup.com/receipt/preview/sample" }));
  await add("mem-fail", "Membership: payment failed", mk("fail", { amount: 11196, retry: addDays(todayKey(), 2) }));
  await add("mem-fail-final", "Membership: cancelled after failed payments", mk("fail_final", { amount: 11196 }));
  await add("mem-card-needed", "Membership: add a card", mk("card_needed", { deadline: addDays(todayKey(), 9) }));
  await add("mem-nocard", "Membership: didn't start (no card)", mk("nocard_cancel"));
  await add("mem-cancelled", "Membership: cancelled (after the minimum)", mk("cancelled", { ends: addDays(todayKey(), 20) }));
  await add("mem-finishing", "Membership: ends after the 3rd month", mk("finishing", { left: 2 }));
  await add("mem-cancelled-free", "Membership: cancelled before the first charge", mk("cancelled_free"));
  await add("mem-detail-cancelled", "Membership: cancelled with its first detail", mk("detail_cancelled", { byUs: false }));
  await add("mem-cancel-fee", "Membership: cancelled now (fee)", mk("cancel_fee", { fee: 10500, ends: addDays(todayKey(), 12), card }));
  const MW = Object.assign({}, M, { type: "wash", monthly_cents: 6000 }), MI = Object.assign({}, M, { type: "int", monthly_cents: 6500 }), mw = (m, kind, o) => E => previewMail(E, m, kind, o);
  await add("mem-winter-soon", "Membership: winter starts in 7 days (Wash + interior)", mk("winter_soon", { day: addDays(todayKey(), 7), ends: "2027-03-01", intMonthly: 6500 }));
  await add("mem-winter-soon-wash", "Membership: winter starts in 7 days (Wash)", mw(MW, "winter_soon", { day: addDays(todayKey(), 7), ends: "2027-03-01" }));
  await add("mem-winter-start", "Membership: winter started (Wash + interior, credit)", mk("winter_start", { adj: { credit: 4000, left: 1, changed: [{ day: addDays(todayKey(), 4), what: "interior" }] }, ends: "2027-03-01", back: "2027-03-05", intMonthly: 6500 }));
  await add("mem-winter-start-wash", "Membership: winter started (Wash paused)", mw(MW, "winter_start", { adj: { credit: 6000, left: 1, changed: [{ day: addDays(todayKey(), 4), what: "cancelled" }] }, ends: "2027-03-01", back: "2027-03-05" }));
  await add("mem-winter-start-ending", "Membership: winter started (Wash, ending, refund)", mw(Object.assign({}, MW, { status: "ending", cancel_mode: "after_min", payments_made: 4 }), "winter_start", { adj: { credit: 5500, left: 1, changed: [], refund: true }, ends: "2027-03-01", back: "2027-03-05" }));
  await add("mem-winter-over-soon", "Membership: winter ends in 7 days", mk("winter_over_soon", { day: addDays(todayKey(), 7), back: addDays(todayKey(), 12) }));
  await add("mem-winter-end", "Membership: winter ended, plan back", mk("winter_end", { back: addDays(todayKey(), 5) }));
  await add("mem-upgrade-offer", "Membership: all plans open, upgrade offer", mw(MI, "upgrade_offer", {}));
  await add("mem-upgrade-set", "Membership: upgrade set", mw(MI, "upgrade_set", { up: { pkg: "exterior", day: addDays(todayKey(), 6), first: 90, monthly: 105, pct: 0.15 }, bill: addDays(todayKey(), 9) }));
  await add("mem-upgrade-dropped", "Membership: upgrade cancelled with its detail", mw(MI, "upgrade_dropped", { up: { pkg: "exterior", day: addDays(todayKey(), 6) } }));
  await add("mem-receipt-upgrade", "Membership: receipt, first upgraded month", mk("receipt", { amount: 9000, tax: 596, credit: 0, full: 9000, listed: 10500, disc: 0.15, period: [todayKey(), addDays(todayKey(), 30)], cover: "both", card }));
  await add("nick-new", "Nick: new booking", E => emailNick(E, B({ _mem: mem, _locFlag: "The address pin is 9 mi from Brick. Check the address and the travel fee.", _photos: [{ name: "concern-1.jpg", data: "" }] }), "new"));
  await add("nick-move", "Nick: rescheduled", E => emailNick(E, B(), "move", "Saturday, November 7, 9:00 AM – 2:00 PM"));
  await add("nick-cancel", "Nick: cancelled", E => emailNick(E, B(), "cancel"));
  await add("nick-mem", "Nick: membership update", E => notifyNick(E, "Membership cancelled now (fee charged): Jordan Rivera", [["Member", "Jordan Rivera · jordan@example.com"], ["Plan", "Wash + interior, monthly (SUV)"], ["Fee", "$105 (no sales tax)"], ["Visits paid through", "Sat, Nov 14"]]));
  return out;
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
  await emailCancelByUs(env, b, credit).catch(() => {});
  return credit;
}

// Day-before reminder emails, sent from 6 PM New York time
async function reminders(env) {
  const now = utcToNy(Date.now()); if (now.min < 18 * 60) return;
  const tmr = addDays(now.key, 1);
  const r = await env.DB.prepare("SELECT * FROM bookings WHERE status = 'confirmed' AND day = ? AND remind = 1 AND reminded_at IS NULL").bind(tmr).all();
  for (const b of r.results || []) {
    const res = await emailCustomer(env, b, "remind").catch(e => ({ error: e.message }));
    if (res && res.error) { console.log("reminder failed, will retry", b.id, String(res.error).slice(0, 200)); continue; }   // try again on the next run
    await env.DB.prepare("UPDATE bookings SET reminded_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
  }
}

// old sign-in codes, sessions and rate-limit rows (audit IA-038)
async function cleanup(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM login_codes WHERE created_at < ?").bind(now - 2 * 864e5),
    env.DB.prepare("DELETE FROM ratelog WHERE at < ?").bind(now - 864e5)
  ]);
}

async function calSave(env, b) {
  const where = [b.address, b.town].filter(Boolean).join(", "), adds = JSON.parse(b.adds || "[]").map(a => ADDON_NAMES[a] || a);
  const desc = [b.name + " · " + b.phone, b.email, pkgName(b) + " · " + SIZES[b.size] + (adds.length ? " + " + adds.join(", ") : ""), b.scent ? "Scent: " + b.scent : "", [b.car, b.color].filter(Boolean).join(" · "),
    b.quote ? (e => "Estimate " + usd(e.sub) + " + " + usd(e.tax) + " tax = " + usd(e.total))(withTax(b.quote * 100)) : "", b.pkg === "interior" ? "Outlet: " + b.power : "Spigot: " + b.water + " · Outlet: " + b.power, b.notes ? "Notes: " + b.notes : "", "Code " + b.id, "Photos / get paid: " + env.SITE_URL + "/admin/#job/" + b.id].filter(Boolean).join("\n");
  const href = await writeJob(env, b, { summary: pkgName(b) + " · " + b.name.split(" ")[0] + (b.town ? " · " + b.town : ""), location: where, description: desc, url: env.SITE_URL + "/admin/#job/" + b.id });
  if (href) await env.DB.prepare("UPDATE bookings SET cal_href = ? WHERE id = ?").bind(href, b.id).run();
  b.cal_href = href;
}

async function manage(req, env, url) {
  const g = url.pathname.match(/^\/b\/([a-f0-9]{36})\/(photos|share|p\/[a-f0-9-]{16,40})$/i);
  if (g) {   // the customer's before/after photo gallery
    const gb = await env.DB.prepare("SELECT * FROM bookings WHERE token = ?").bind(g[1]).first();
    if (!gb) return html(page("Not found", "<h1>Link not found</h1>"), 404);
    const r = await galleryRoute(req, env, url, gb, g[2], { page, html, pkgName, whenText });
    return r || html(page("Not found", "<h1>Link not found</h1>"), 404);
  }
  const m = url.pathname.match(/^\/b\/([a-f0-9]{36})(?:\/(cancel|move|scent))?$/);
  if (!m) return html(page("Not found", "<h1>Link not found</h1>"), 404);
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE token = ?").bind(m[1]).first();
  if (!b) return html(page("Not found", `<h1>We couldn't find that booking</h1><p class="sub">Text us at (732) 206-7084 and we'll sort it out.</p>`), 404);
  if (!m[2] || req.method !== "POST") {
    const code = url.searchParams.get("m"), cr = +url.searchParams.get("c") || 0;
    const msg = code === "skipped" && cr ? "Skipped. A " + usd(cr) + " credit goes toward your next monthly charge." : MSGS[code] || "";
    return html(await managePage(env, b, msg));
  }
  if (m[2] === "scent") {   // change the scent until the job starts (Nick gets a heads-up)
    const o = req.headers.get("Origin"); if (o && o !== url.origin) return html(page("Not allowed", "<h1>Not allowed</h1>"), 403);
    if (b.status !== "confirmed" || !scentFor(b) || jobStarted(b)) return html(await managePage(env, b, "The scent can't be changed online anymore. Text us at (732) 206-7084."));
    const fd = await req.formData().catch(() => null), sc = pickScent(b.pkg, fd && fd.get("scent"), b.scent);
    if (sc.err) return html(await managePage(env, b, sc.err));
    if (sc.scent !== b.scent) {
      const was = b.scent || NO_SCENT;
      await env.DB.prepare("UPDATE bookings SET scent = ? WHERE id = ?").bind(sc.scent, b.id).run(); b.scent = sc.scent;
      const quiet = await overLimit(env, req, "scentmail:" + b.id, 3, 3600e3);   // at most 3 heads-ups an hour per booking
      await Promise.all([calConfigured(env) ? calSave(env, b).catch(() => {}) : null, quiet ? null : emailNick(env, b, "scent", was).catch(() => {})]);
    }
    return backTo(b, "scent", "#scent");
  }
  if (b.status !== "confirmed") return html(await managePage(env, b));
  const hoursLeft = (b.start_utc - Date.now()) / 3600e3;
  if (hoursLeft < RULES.noticeHours && !(b.kind === "member" && m[2] === "cancel")) return html(await managePage(env, b, "It's too close to change online."));
  if (fixedLength(b)) return html(await managePage(env, b, "Text us to change this one."));
  if (m[2] === "cancel") {
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
    b.status = "cancelled";
    const credit = await creditVisit(env, b, hoursLeft >= MEM.skipNoticeHours ? MEM.skipCreditRate : 0);
    if (b.kind === "member") {
      await Promise.all([deleteJob(env, b.cal_href).catch(() => {}), emailNick(env, b, "cancel").catch(() => {}), emailSkip(env, b, credit).catch(() => {})]);
      return backTo(b, "skipped", credit ? "&c=" + credit : "");
    }
    await Promise.all([deleteJob(env, b.cal_href).catch(() => {}), emailCustomer(env, b, "cancel").catch(() => {}), emailNick(env, b, "cancel").catch(() => {})]);
    const memC = await cancelWithDetail(env, b, false).catch(e => { console.log("membership cancel failed", e.message); return null; });
    return backTo(b, memC ? "cancelled_mem" : "cancelled");
  }
  const fd = await req.formData(), day = String(fd.get("day") || ""), start = +fd.get("start");
  const adds = b.kind === "member" ? ["_member"] : JSON.parse(b.adds || "[]");
  if (b.kind === "member") {
    const mm = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(b.membership_id).first();
    const cv = mm && visitCover(mm, day);
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
  return backTo(b, "moved");
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

// IA-058: security headers (static files get the same from public/_headers)
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=()", "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "Strict-Transport-Security": "max-age=31536000" };
function secure(res) { const out = new Response(res.body, res); for (const [k, v] of Object.entries(SEC_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v); return out; }

export default {
  async fetch(req, env) { await loadSettings(env); return secure(await handle(req, env)); },
  async scheduled(event, env, ctx) { await loadSettings(env); return scheduledRun(event, env, ctx); }
};

// The home page with the prices, job lengths and seasons Nick set in the dashboard (window.__APEX_SETTINGS, applied by the site's script)
async function homePage(req, env) {
  const r = await env.ASSETS.fetch(req);
  if (!r.ok || !/text\/html/.test(r.headers.get("Content-Type") || "")) return r;
  const data = JSON.stringify(publicSettings()).replace(/</g, "\\u003c");
  const out = new HTMLRewriter().on("head", { element(e) { e.prepend("<script>window.__APEX_SETTINGS=" + data + ";</script>", { html: true }); } }).transform(r);
  const res = new Response(out.body, out); res.headers.set("Cache-Control", "no-cache"); res.headers.delete("ETag"); return res;
}

// what the owner dashboard API (admin.js / owner.js) can use from here
const OWNER_H = { syncBusy, pkgName, emailCustomer, emailNick, calSave: (env, b) => (calConfigured(env) ? calSave(env, b) : Promise.resolve()), days, cancelByUs, creditVisit, emailSkip, emailCancelByUs,
  code, secret, page, html, whenText, dayLabel };

async function handle(req, env) {
    const url = new URL(req.url);
    // one address for the site, always https: www.apexdetailingoc.com or http:// -> https://apexdetailingoc.com
    if (/(^|\.)apexdetailingoc\.com$/.test(url.hostname) && (url.hostname.startsWith("www.") || url.protocol === "http:")) return Response.redirect("https://apexdetailingoc.com" + url.pathname + url.search, 301);
    // owner actions (dashboard writes, job page, Got it) must come from this site's own pages (audit IA-037)
    const ownerWrite = req.method !== "GET" && req.method !== "HEAD" && (url.pathname.startsWith("/api/admin/") || url.pathname.startsWith("/job/") || url.pathname.startsWith("/ack/"));
    if (ownerWrite) { const o = req.headers.get("Origin"); if (o && o !== url.origin) return json({ error: "Not allowed" }, 403);
      const ct = req.headers.get("Content-Type") || "", upload = url.pathname === "/api/admin/photos" && /^multipart\/form-data/.test(ct);
      if (url.pathname.startsWith("/api/admin/") && req.method !== "DELETE" && !upload && !/^application\/json\b/i.test(ct)) return json({ error: "Send JSON" }, 415); }
    try {
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/") || url.pathname.startsWith("/api/admin/")) {
        const who = await accessUser(req, env).catch(e => { console.log("admin auth error", e.message); return null; });
        if (!who) { console.log("admin denied", url.pathname); return url.pathname.startsWith("/api/") ? json({ error: "Not allowed" }, 403) : html(page("Not allowed", "<h1>Owner only</h1><p class='sub'>Sign in through Cloudflare Access to open the dashboard.</p>"), 403); }
        if (url.pathname.startsWith("/api/admin/")) return await adminApi(req, env, url, OWNER_H, who);
        if (url.pathname === "/admin") return Response.redirect(url.origin + "/admin/", 302);
        const r = await env.ASSETS.fetch(req); const out = new Response(r.body, r); out.headers.set("Cache-Control", "no-store"); out.headers.set("X-Robots-Tag", "noindex");
        out.headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self), usb=()");   // the dashboard camera (before/after photos)
        if (url.pathname.endsWith("/sw.js")) out.headers.set("Service-Worker-Allowed", "/admin/");
        return out;
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
      if ((url.pathname === "/" || url.pathname === "/index.html") && (req.method === "GET" || req.method === "HEAD")) return await homePage(req, env);
    } catch (e) {
      console.log("error", e.stack || e.message);
      return url.pathname.startsWith("/api/") ? json({ error: "Something went wrong on our side. Please text (732) 206-7084." }, 500) : html(page("Error", "<h1>Something went wrong</h1><p class='sub'>Please text (732) 206-7084.</p>"), 500);
    }
    return env.ASSETS.fetch(req);
}

async function scheduledRun(event, env, ctx) {
  {
    ctx.waitUntil(syncBusy(env).then(r => console.log("sync", JSON.stringify(r))).catch(e => console.log("sync failed", e.message)));
    ctx.waitUntil(reminders(env).catch(e => console.log("reminders failed", e.message)));
    ctx.waitUntil(runBilling(env, { settingsOk: settingsLoaded(), calSave: b => calConfigured(env) ? calSave(env, b) : Promise.resolve(), deleteJob: href => deleteJob(env, href) }).then(l => l.length && console.log("billing", JSON.stringify(l))).catch(e => console.log("billing failed", e.message)));
    if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 10) {   // once an hour
      ctx.waitUntil(cleanup(env).catch(e => console.log("cleanup failed", e.message)));
      ctx.waitUntil(purgeTrash(env).catch(e => console.log("photo trash failed", e.message)));
      ctx.waitUntil(syncSquare(env).then(r => r.payments && console.log("square sync", JSON.stringify(r))).catch(e => console.log("square sync failed", e.message)));
    }
  }
}

export { emailCustomer, emailNick };
