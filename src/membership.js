// Apex Membership: sign-up, monthly billing on the anniversary date, visits, skips/credits, pause, cancel.
// Rules are in public/membership-terms.html — keep the two in sync.
import { PRICING, TAX, taxCents } from "./pricing.js";
import { RULES, inWinter, parseDay, dayKey, addDays, utcToNy, nyToUtc, slotsFor, dayInfo, jobMin } from "./sched.js";
import { charge } from "./square.js";
import { send, layout, rows, buttons, hero, para, note, am, h } from "./email.js";

export const MEM = {
  plans: { wash: { of: "exterior", pct: 0.55, name: "Wash" }, int: { of: "interior", pct: 0.35, name: "Interior" }, both: { of: "full", pct: 0.38, name: "Wash + interior" } },
  freqDiscount: { 1: 0, 2: 0.10, 4: 0.20 },
  freqName: { 1: "monthly", 2: "every 2 weeks", 4: "weekly" },
  prereq: { wash: ["exterior", "full"], int: ["interior", "full"], both: ["full"] },
  visitPkg: { wash: "exterior", int: "interior", both: "full" },
  // winter: Nick's Settings → Winter mode dates (RULES.winter), same as bookings (Membership Terms §6, Nov 3: "the dates we set").
  // Wash pauses; Wash + interior gets interior visits at the Interior price; Interior carries on.
  upgradePct: 0.15,   // first upgraded month (Interior → Wash + interior) is 15% off (Nick, Nov 3)
  signupDays: 14, minPayments: 3, cancelFeeRate: 0.5, skipCreditRate: 0.5, skipNoticeHours: 48, billHour: 9, retryDays: [2, 4, 7]
};
const SIZES = ["Sedan", "SUV", "Truck"];
const round5 = x => Math.round(x / 5) * 5;
const money = c => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const TAX_LABEL = TAX.name + " (" + TAX.pct + ")";   // monthly prices and fees are before tax; NJ sales tax is added to every charge
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), x => x.toString(16).padStart(2, "0")).join("");

export function planPrice(type, size, freq) {
  const m = MEM.plans[type], base = round5(PRICING.regular[m.of][size] * m.pct);
  const perVisit = round5(base * (1 - (MEM.freqDiscount[freq] || 0)));
  return { perVisit, monthly: perVisit * freq, oneoff: PRICING.regular[m.of][size] };
}
export function planLabel(type, freq, size) { return MEM.plans[type].name + ", " + MEM.freqName[freq] + " (" + SIZES[size] + ")"; }

// same day-of-month as the start, clamped to the month's last day
export function addMonths(startKey, n) {
  const { y, m, d } = parseDay(startKey); const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, Math.min(d, last));
}
export const monthsBetween = (startKey, key) => { let n = 0; while (addMonths(startKey, n + 1) <= key) n++; return n; };
const todayNY = () => utcToNy(Date.now());
// winter = Settings → Winter mode (start == end means off). W lets the dashboard preview dates before saving.
const winterWith = (W, key) => { const { m, d } = parseDay(key), v = m * 100 + d, s = W.start[0] * 100 + W.start[1], e = W.end[0] * 100 + W.end[1]; return s > e ? (v >= s || v < e) : (v >= s && v < e); };
const winterDay = key => winterWith(RULES.winter, key);
// the next day winter starts or ends, within `days` days (null if none)
export function nextFlip(from, days, W) { W = W || RULES.winter; const now = winterWith(W, from); for (let i = 1; i <= days; i++) { const k = addDays(from, i); if (winterWith(W, k) !== now) return k; } return null; }
// the day the current season (winter or not) began
function seasonStart(from, W) { W = W || RULES.winter; const now = winterWith(W, from); for (let i = 1; i <= 400; i++) { const k = addDays(from, -i); if (winterWith(W, k) !== now) return addDays(k, 1); } return null; }
// first billing date on or after a day (their anniversary date; a later next_bill wins, e.g. paused)
function billOnOrAfter(m, key) {
  if (m.next_bill && m.next_bill >= key) return m.next_bill;
  const n = monthsBetween(m.start_day, key); let d = addMonths(m.start_day, n); if (d < key) d = addMonths(m.start_day, n + 1); return d;
}
// the first billing date on or after a day that isn't in winter (when a full-price month can start), within 14 months
function firstOpenBill(m, key) { let d = billOnOrAfter(m, key); for (let i = 0; i < 14 && winterDay(d); i++) d = addMonths(m.start_day, monthsBetween(m.start_day, d) + 1); return d; }
// joined while winter was on (only the Interior plan could start then): their upgrade's first month is discounted.
// Marked when they join (meta memwj:<id>) or when the "all plans are open" offer goes out, so turning winter mode off later doesn't lose it.
const joinedInWinter = async (env, m) => m.type === "int" && !!(await getMeta(env, "memwj:" + m.id));
// will they be charged again? (an 'ending' membership only is when it's finishing its 3-month minimum)
const billsAgain = m => m.status !== "cancelled" && !(m.status === "ending" && !(m.cancel_mode === "finish" && m.payments_made < MEM.minPayments));
// The winter price (Wash + interior billed at the Interior price) is locked when they sign up or change plan, like the monthly
// price, so later price changes in the dashboard don't change what current members pay. Kept in meta('memw:<id>').
async function saveWinter(env, id, type, size, freq) {
  if (type !== "both") return;
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind("memw:" + id, String(planPrice("int", size, freq).monthly * 100)).run();
}
async function coverCents(env, m, cover) {
  if (cover === m.type) return m.monthly_cents;
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind("memw:" + m.id).first().catch(() => null);
  return r && +r.v > 0 ? +r.v : planPrice(cover, m.size, m.freq).monthly * 100;
}
function niceDay(key) { if (!key) return ""; const { y, m, d } = parseDay(key); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }); }

// What a visit covers on a given day (winter: wash pauses, wash + interior gets interior visits)
export function coverOn(type, key) { if (!winterDay(key)) return type; return type === "wash" ? null : type === "both" ? "int" : type; }
// What a member visit on a given day covers, within what this month paid for: a month billed at the Interior price stays
// interior even after winter ends; a Wash month that winter cut short ("off": credited) has no visits left.
export function visitCover(m, key) {
  const c = coverOn(m.type, key);
  if (c === null || m.period_type === "off") return null;
  if (m.type === "both" && (c === "int" || m.period_type === "int")) return "int";
  return c;
}

async function upd(env, id, fields) {
  const k = Object.keys(fields); fields.updated_at = Date.now(); k.push("updated_at");
  await env.DB.prepare("UPDATE memberships SET " + k.map(x => x + " = ?").join(", ") + " WHERE id = ?").bind(...k.map(x => fields[x]), id).run();
}
export async function activeFor(env, customerId) {
  return env.DB.prepare("SELECT * FROM memberships WHERE customer_id = ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1").bind(customerId).first();
}

// ---------- sign-up ----------
// From the booking form (qualifying detail is that booking) or from the account within 14 days of a qualifying detail.
export async function createMembership(env, { customerId, booking, type, freq, auth }) {
  if (!MEM.plans[type] || ![1, 2, 4].includes(+freq)) throw new Error("Pick a plan.");
  if (!MEM.prereq[type].includes(booking.pkg)) throw new Error("That plan starts after a " + (type === "both" ? "Full Detail" : type === "int" ? "Interior or Full Detail" : "Exterior or Full Detail") + ".");
  const existing = await activeFor(env, customerId);
  if (existing) throw new Error("You already have an Apex Membership.");
  const p = planPrice(type, booking.size, +freq), now = Date.now(), id = rid();
  await env.DB.prepare(`INSERT INTO memberships (id, customer_id, status, type, freq, size, car, monthly_cents, qualifying_booking, start_day, next_bill, terms_version, auth_at, auth_ip, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, customerId, booking.day <= todayNY().key ? "active" : "pending", type, +freq, booking.size, booking.car || null, p.monthly * 100,
    booking.id, booking.day, addMonths(booking.day, 1), auth.version, auth.at, auth.ip, now, now).run();
  await saveWinter(env, id, type, booking.size, +freq);
  if (type === "int" && winterDay(todayNY().key)) await setMeta(env, "memwj:" + id, "1");   // joined in winter: upgrade offer + discount later
  const fc = firstCharge(type, booking.size, +freq, booking.day);
  return { id, monthly: p.monthly, firstBill: fc.day, firstAmount: fc.amount, firstSkipped: fc.skipped, firstWinter: fc.winterPrice, label: planLabel(type, +freq, booking.size) };
}

// The first charge exactly as billOne() will make it: one month after the qualifying detail, skipping winter months for
// Wash plans, and at the Interior price for Wash + interior in winter. Amount is before tax, in dollars.
export function firstCharge(type, size, freq, startDay) {
  const monthly = planPrice(type, size, freq).monthly;
  for (let n = 1; n <= 12; n++) {
    const day = addMonths(startDay, n), cover = coverOn(type, day);
    if (cover === null) continue;
    return { day, amount: cover === type ? monthly : planPrice(cover, size, freq).monthly, skipped: n - 1, winterPrice: cover !== type };
  }
  return { day: addMonths(startDay, 1), amount: monthly, skipped: 0, winterPrice: false };
}

// The detail a customer can start a membership from: the latest one in the last 14 days, else their next upcoming one.
export async function qualifyingFor(env, customerId, today) {
  const since = addDays(today, -MEM.signupDays);
  const r = (await env.DB.prepare("SELECT * FROM bookings WHERE customer_id = ? AND kind != 'member' AND status = 'confirmed' AND day >= ? ORDER BY day").bind(customerId, since).all()).results || [];
  const past = r.filter(b => b.day <= today);
  return past.length ? past[past.length - 1] : r[0] || null;
}

// The first detail moved: the membership's dates move with it (only before the first monthly charge). Audit IA-007.
export async function moveWithDetail(env, booking) {
  await moveUpgrades(env, booking).catch(e => console.log("upgrade move failed", e.message));
  const m = await env.DB.prepare("SELECT * FROM memberships WHERE qualifying_booking = ? AND status IN ('pending','active') AND payments_made = 0").bind(booking.id).first();
  if (!m) return null;
  const today = todayNY().key, first = addMonths(booking.day, 1);
  await upd(env, m.id, { start_day: booking.day, next_bill: first, status: booking.day <= today ? "active" : "pending", card_reminders: 0 });
  return { id: m.id, monthly: m.monthly_cents / 100, firstBill: first, label: planLabel(m.type, m.freq, m.size) };
}

// The first detail was cancelled: the membership can't start, so it's cancelled too (no charge yet) and both sides get an email. Audit IA-010.
export async function cancelWithDetail(env, booking, byUs) {
  await dropUpgrades(env, booking.id).catch(e => console.log("upgrade drop failed", e.message));
  const m = await env.DB.prepare("SELECT m.*, c.email, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.qualifying_booking = ? AND m.status IN ('pending','active') AND m.payments_made = 0").bind(booking.id).first();
  if (!m) return null;
  await upd(env, m.id, { status: "cancelled", ends_on: todayNY().key, cancel_mode: "detail_cancelled", cancel_requested_at: Date.now() });
  await mail(env, m, "detail_cancelled", { byUs });
  await notifyNick(env, "Membership cancelled with its first detail: " + (m.name || m.email), [["Member", (m.name || "") + " · " + m.email], ["Plan", planLabel(m.type, m.freq, m.size)], ["Why", byUs ? "You cancelled the first detail (weather/our side)" : "The customer cancelled the first detail"], ["Charged", "Nothing (no monthly charge yet)"]]);
  return m;
}

export async function notifyNick(env, subject, list) {
  if (!env.NICK_EMAIL) return;
  const k = subject.split(":")[0], rest = subject.slice(k.length + 1).trim();
  return send(env, { to: env.NICK_EMAIL, subject, html: layout(subject, hero("Apex Membership", h(k), rest ? h(rest) : "") + rows(list), subject, env.SITE_URL, { who: "nick" }) }).catch(() => {});
}

// ---------- summary for the account page ----------
export async function summary(env, m, customer) {
  if (!m) return null;
  const today = todayNY().key, card = customer.card ? JSON.parse(customer.card) : null;
  const visits = await env.DB.prepare("SELECT id, token, status, start_utc, end_utc, day, pkg FROM bookings WHERE membership_id = ? AND kind = 'member' ORDER BY start_utc").bind(m.id).all();
  const list = (visits.results || []);
  const inPeriod = m.period_start ? list.filter(v => v.day >= m.period_start && v.day < m.period_end) : [];   // skipped visits count as used (they earn a credit instead)
  const allowed = m.period_start && ["active", "ending", "paused"].includes(m.status) && today < m.period_end && m.period_type !== "off" ? m.freq : 0;
  const remaining = Math.max(0, MEM.minPayments - m.payments_made);
  const fee = Math.round(MEM.cancelFeeRate * remaining * m.monthly_cents / 100) * 100;
  const qual = m.start_day, cardDeadline = addDays(qual, MEM.signupDays);
  // the next charge as billOne() will make it: winter may pause Wash or bill Wash + interior at the Interior price; credits come off before tax
  let cov = m.next_bill ? coverOn(m.type, m.next_bill) : m.type, nextFull = cov === null ? 0 : await coverCents(env, m, cov);
  const upW = m.type === "int" && m.next_bill ? await getUpgrade(env, m.id) : null;
  if (upW && m.next_bill >= upW.day && coverOn("both", m.next_bill) === "both") { cov = "both"; nextFull = round5(upW.monthly * (1 - (upW.pct || 0))) * 100; }   // the upgrade starts with this charge
  else if (cov === m.type && cov !== null) { const dc = +(await getMeta(env, "memdisc:" + m.id)) || 0; if (dc) nextFull = round5(nextFull / 100 * (1 - dc)) * 100; }
  const nextSub = nextFull - Math.min(m.credit_cents, nextFull), nextTotal = nextSub + taxCents(nextSub);
  return {
    id: m.id, status: m.status, type: m.type, freq: m.freq, size: m.size, car: m.car, label: planLabel(m.type, m.freq, m.size), monthly: m.monthly_cents / 100,
    monthlyTax: taxCents(m.monthly_cents) / 100, monthlyTotal: (m.monthly_cents + taxCents(m.monthly_cents)) / 100, cancelFeeTax: 0, cancelFeeTotal: fee / 100, nextChargeTotal: nextTotal / 100, nextWinter: cov !== m.type,
    since: m.start_day, nextBill: m.status === "cancelled" || (m.status === "ending" && !(m.cancel_mode === "finish" && m.payments_made < MEM.minPayments)) ? null : m.next_bill, periodStart: m.period_start, periodEnd: m.period_end,
    paymentsMade: m.payments_made, minLeft: remaining, cancelFee: fee / 100, credit: m.credit_cents / 100, owed: m.owed_cents / 100, endsOn: m.ends_on, cancelMode: m.cancel_mode, pauseUntil: m.pause_until,
    needsCard: !card, cardDeadline, card: card ? card.brand + " ending " + card.last4 : null,
    visitsAllowed: allowed, visitsBooked: inPeriod.length, coverNow: m.period_type === "off" ? null : m.period_type || coverOn(m.type, today), winterCut: m.period_type === "off" && today < (m.period_end || ""),
    winterNow: winterDay(today), winterEnds: winterDay(today) ? nextFlip(today, 400) : null, winterStarts: winterDay(today) ? null : nextFlip(today, 400),
    fullBack: winterDay(today) && m.type !== "int" ? billOnOrAfter(m, nextFlip(today, 400) || today) : null,
    upgrade: await upgradeInfo(env, m, today),
    upcoming: list.filter(v => v.status === "confirmed" && v.end_utc > Date.now()).map(v => ({ id: v.id, start: v.start_utc, end: v.end_utc, day: v.day, pkg: v.pkg, manage: env.SITE_URL + "/b/" + v.token })),
    canPause: m.status === "active" && m.payments_made >= MEM.minPayments
  };
}

// ---------- open times for a member visit (current paid period only) ----------
export async function visitSlots(env, m, H) {
  const today = todayNY().key;
  if (!m.period_start || !["active", "ending", "paused"].includes(m.status) || today >= m.period_end) return { days: [], reason: m.status === "past_due" ? "Your last payment didn't go through. Update your card to book visits." : m.status === "paused" ? "Your membership is paused." : m.status === "pending" || !m.period_start ? "You can book visits once your first month is paid, one month after your detail." : "Your next month isn't paid yet." };
  const booked = await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE membership_id = ? AND kind = 'member' AND day >= ? AND day < ?").bind(m.id, m.period_start, m.period_end).first();
  if (m.period_type === "off") return { days: [], reason: "Winter started this month, so the rest of this month's Wash visits were credited to your next charge." };
  if (booked.n >= m.freq) return { days: [], reason: "You've used all " + m.freq + " visit" + (m.freq > 1 ? "s" : "") + " for this month." };
  const cover = m.period_type || m.type; const pkg = MEM.visitPkg[cover];
  let from = today > m.period_start ? today : m.period_start; const n = Math.min(35, Math.round((nyToUtc(m.period_end, 0) - nyToUtc(from, 0)) / 864e5));
  const info = await H.days(env, from, n), out = [];
  for (const k of Object.keys(info)) { if (k >= m.period_end) break; const cv = visitCover(m, k); if (cv === null) continue; const s = slotsFor(k, info[k], MEM.visitPkg[cv], m.size, ["_member"], Date.now()); if (s.length) out.push({ day: k, label: niceDay(k), slots: s }); }
  return { days: out, pkg, left: m.freq - booked.n };
}

// ---------- monthly billing (runs from the cron) ----------
export async function runBilling(env, H) {
  const now = todayNY(), today = now.key, log = [];
  // pending -> active once the qualifying detail day arrives (or cancelled if that detail was cancelled)
  const pend = await env.DB.prepare("SELECT m.*, b.status bstatus FROM memberships m LEFT JOIN bookings b ON b.id = m.qualifying_booking WHERE m.status = 'pending'").all();
  for (const m of pend.results || []) {
    if (m.bstatus === "cancelled") { await cancelWithDetail(env, { id: m.qualifying_booking }, false); log.push(m.id + " cancelled (detail cancelled)"); }
    else if (m.start_day <= today) { await upd(env, m.id, { status: "active" }); log.push(m.id + " active"); }
  }
  // card required within 14 days of the qualifying detail
  const noCard = await env.DB.prepare("SELECT m.*, c.email, c.name, c.card FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.status = 'active' AND m.payments_made = 0 AND (c.card IS NULL OR c.card = '')").all();
  for (const m of noCard.results || []) {
    const deadline = addDays(m.start_day, MEM.signupDays);
    if (today > deadline) { await upd(env, m.id, { status: "cancelled", ends_on: today, cancel_mode: "no_card" }); await mail(env, m, "nocard_cancel"); log.push(m.id + " cancelled (no card)"); continue; }
    const due = [1, 10].filter(d => addDays(m.start_day, d) <= today).length;
    if (due > m.card_reminders && now.min >= 10 * 60) { await upd(env, m.id, { card_reminders: due }); await mail(env, m, "card_needed", { deadline }); log.push(m.id + " card reminder"); }
  }
  // memberships that end today
  const ending = await env.DB.prepare("SELECT * FROM memberships WHERE status IN ('ending','paused','active') AND ends_on IS NOT NULL AND ends_on < ?").bind(today).all();
  for (const m of ending.results || []) { await upd(env, m.id, { status: "cancelled" }); log.push(m.id + " ended"); }
  // pauses that are over
  const paused = await env.DB.prepare("SELECT * FROM memberships WHERE status = 'paused' AND pause_until <= ?").bind(today).all();
  for (const m of paused.results || []) { await upd(env, m.id, { status: "active", pause_until: null }); log.push(m.id + " unpaused"); }
  if (now.min < MEM.billHour * 60 && !(env.ADMIN_DEV === "1" && await getMeta(env, "dev:billnow"))) return log;   // dev:billnow = local tests only
  // winter dates come from Settings: if they didn't load, don't guess (the defaults could flip the season and bill at the wrong price)
  if (H && H.settingsOk === false) { log.push("settings didn't load: billing skipped this run"); return log; }
  try { log.push(...await seasonTick(env, today, H || {})); } catch (e) { log.push("season error " + e.message); }   // winter starts/ends (before the charges)
  // charges due today (first charges, renewals, and retries of failed charges)
  const due = await env.DB.prepare("SELECT m.*, c.email, c.name, c.card, c.square_customer_id FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE ((m.status IN ('active','ending') AND m.next_bill <= ?) OR (m.status = 'past_due' AND m.retry_day <= ?))").bind(today, today).all();
  for (const m of due.results || []) {
    try { log.push(m.id + " " + await billOne(env, m, today)); } catch (e) { log.push(m.id + " error " + e.message); }
  }
  return log;
}

// manual: the member tapped "Retry payment". A failed manual try doesn't use up the automatic retries (review after the audit).
async function billOne(env, m, today, manual) {
  const billDay = m.status === "past_due" ? m.next_bill : m.next_bill;
  // a membership that's ending doesn't renew
  if (m.status === "ending" && m.cancel_mode !== "finish") { await upd(env, m.id, { status: "cancelled", ends_on: addDays(billDay, -1) }); return "ended at renewal"; }
  if (m.status === "ending" && m.cancel_mode === "finish" && m.payments_made >= MEM.minPayments) { await upd(env, m.id, { status: "cancelled", ends_on: addDays(billDay, -1) }); return "finished minimum"; }
  // an upgrade waiting for its Exterior/Full Detail takes effect with the first charge on or after that detail
  const up = m.type === "int" ? await getUpgrade(env, m.id) : null;
  if (up && billDay >= up.day && coverOn("both", billDay) === "both") {   // waits through winter, so the first upgraded month is a full-price one
    const ub = await env.DB.prepare("SELECT status, pkg FROM bookings WHERE id = ?").bind(up.booking).first();
    await delMeta(env, "memup:" + m.id);
    if (!ub || ub.status !== "confirmed" || !["exterior", "full"].includes(ub.pkg)) await mail(env, m, "upgrade_dropped", { up });
    else {
      await upd(env, m.id, { type: "both", monthly_cents: up.monthly * 100 });
      await setMeta(env, "memw:" + m.id, m.monthly_cents);   // winter months = the Interior price they already pay
      if (up.pct > 0) await setMeta(env, "memdisc:" + m.id, up.pct);
      Object.assign(m, { type: "both", monthly_cents: up.monthly * 100 });
    }
  }
  const cover = coverOn(m.type, billDay);
  if (cover === null) {   // winter: wash plans pause, no charge, doesn't count toward the minimum
    await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, status, for_day, created_at) VALUES (?, ?, 'winter_skip', 0, 'skipped', ?, ?)").bind(rid(), m.id, billDay, Date.now()).run();
    const pf = { next_bill: addMonths(m.start_day, monthsBetween(m.start_day, billDay) + 1), period_start: null, period_end: null };
    if (m.status === "past_due") Object.assign(pf, { status: "active", retry_day: null, fail_count: 0, owed_cents: 0 });   // that month is now winter: nothing owed
    await upd(env, m.id, pf);
    return "winter pause";
  }
  const listed = await coverCents(env, m, cover);
  const disc = cover === m.type ? +(await getMeta(env, "memdisc:" + m.id)) || 0 : 0;   // first upgraded month (a full-price month)
  const full = disc ? round5(listed / 100 * (1 - disc)) * 100 : listed;
  const credit = Math.min(m.credit_cents, full), amount = full - credit, tax = taxCents(amount), total = amount + tax;   // credits come off before tax
  const card = m.card ? JSON.parse(m.card) : null;
  let p = null;
  if (amount > 0) {
    if (!card) return manual ? "failed (No card on file)" : failed(env, m, billDay, amount, credit, "No card on file");
    // the key includes the card, so a retry with the same card is the same payment (no double charge if the cron and a
    // tap overlap) and a new card is a fresh try
    try { p = await charge(env, { source: card.id, amount: total, customerId: m.square_customer_id, reference: "MEM-" + m.id.slice(0, 8), note: "Apex Membership · " + planLabel(m.type, m.freq, m.size) + " · " + billDay + " · " + money(amount) + " + " + money(tax) + " " + TAX.name, email: m.email, idem: "mem-" + m.id + "-" + billDay + "-" + (m.fail_count || 0) + "-" + String(card.id).slice(-8) }); }
    catch (e) {
      if (!manual) return failed(env, m, billDay, amount, credit, e.message);
      await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, credit_used_cents, status, error, for_day, created_at) VALUES (?, ?, 'monthly', ?, ?, ?, 'failed', ?, ?, ?)").bind(rid(), m.id, amount, tax, credit, "Retry: " + String(e.message).slice(0, 290), billDay, Date.now()).run();
      return "failed (" + e.message + ")";
    }
  }
  const periodEnd = addMonths(m.start_day, monthsBetween(m.start_day, billDay) + 1);
  try {
    await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, credit_used_cents, status, payment_id, receipt_url, for_day, created_at) VALUES (?, ?, 'monthly', ?, ?, ?, 'paid', ?, ?, ?, ?)")
      .bind(rid(), m.id, amount, tax, credit, p ? p.id : null, p ? p.receipt : null, billDay, Date.now()).run();
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {   // this day is already paid (cron and "Retry payment" at once, or a stale next_bill): move on, never bill it twice
      await env.DB.prepare("UPDATE memberships SET next_bill = ?, updated_at = ? WHERE id = ? AND next_bill = ?").bind(periodEnd, Date.now(), m.id, billDay).run();
      return "already billed (another run got there first)";
    }
    throw e;
  }   // cron and "Retry payment" at once (audit IA-038)
  if (disc) await delMeta(env, "memdisc:" + m.id);
  const made = m.payments_made + 1;
  const fields = { status: m.status === "past_due" ? "active" : m.status, payments_made: made, credit_cents: m.credit_cents - credit, fail_count: 0, retry_day: null, owed_cents: 0,
    period_start: billDay, period_end: periodEnd, period_visit_cents: Math.round(full / m.freq), period_type: cover, next_bill: periodEnd };
  if (m.cancel_mode === "finish" && made >= MEM.minPayments) { fields.status = "ending"; fields.ends_on = addDays(periodEnd, -1); }
  await upd(env, m.id, fields);
  await mail(env, m, "receipt", { amount, tax, credit, full, listed, disc, period: [billDay, periodEnd], cover, receipt: p && p.receipt, card, last: fields.ends_on });
  return "charged " + total;
}

// amount is before tax; what's owed (and shown to the member) includes NJ sales tax
async function failed(env, m, billDay, amount, credit, why) {
  const fails = (m.fail_count || 0) + 1, today = todayNY().key, tax = taxCents(amount), total = amount + tax;
  await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, credit_used_cents, status, error, for_day, created_at) VALUES (?, ?, 'monthly', ?, ?, ?, 'failed', ?, ?, ?)").bind(rid(), m.id, amount, tax, credit, String(why).slice(0, 300), billDay, Date.now()).run();
  if (fails > MEM.retryDays.length) {
    await upd(env, m.id, { status: "cancelled", ends_on: today, cancel_mode: "payment_failed", owed_cents: total, fail_count: fails });
    await mail(env, m, "fail_final", { amount: total }); return "cancelled after failed payments";
  }
  await upd(env, m.id, { status: "past_due", fail_count: fails, retry_day: addDays(today, MEM.retryDays[fails - 1]), owed_cents: total });
  await mail(env, m, "fail", { amount: total, retry: addDays(today, MEM.retryDays[fails - 1]) }); return "failed (" + why + ")";
}

// Try a past-due charge again right away (after the member updates their card)
export async function retryNow(env, m) {
  const c = await env.DB.prepare("SELECT email, name, card, square_customer_id FROM customers WHERE id = ?").bind(m.customer_id).first();
  return billOne(env, Object.assign({}, m, c), todayNY().key, true);
}

// ---------- cancel / pause ----------
export async function cancelMembership(env, m, mode, customer) {
  const today = todayNY().key;
  if (m.status === "cancelled") throw new Error("Already cancelled.");
  if (m.status === "pending" || m.payments_made === 0) {   // before the first monthly charge: free (no member benefits used yet)
    await upd(env, m.id, { status: "cancelled", ends_on: today, cancel_mode: "before_start", cancel_requested_at: Date.now() });
    await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "cancelled_free");
    await notifyNick(env, "Membership cancelled (before the first charge): " + (customer.name || customer.email), [["Member", (customer.name || "") + " · " + customer.email], ["Plan", planLabel(m.type, m.freq, m.size)], ["Charged", "Nothing"]]);
    return { message: "Your membership is cancelled. You won't be charged. We emailed you a confirmation." };
  }
  if (m.payments_made >= MEM.minPayments) {
    const ends = m.period_end ? addDays(m.period_end, -1) : today;
    await upd(env, m.id, { status: "ending", cancel_mode: "after_min", ends_on: ends, cancel_requested_at: Date.now() });
    await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "cancelled", { ends });
    await notifyNick(env, "Membership cancelled: " + (customer.name || customer.email), [["Member", (customer.name || "") + " · " + customer.email], ["Plan", planLabel(m.type, m.freq, m.size)], ["Active through", niceDay(ends)], ["Fee", "None (minimum done)"]]);
    return { message: "Cancelled. No more charges. Your membership stays active through " + niceDay(ends) + "." };
  }
  if (mode === "finish") {
    await upd(env, m.id, { status: "ending", cancel_mode: "finish", cancel_requested_at: Date.now() });
    await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "finishing", { left: MEM.minPayments - m.payments_made });
    await notifyNick(env, "Membership ending after the 3-month minimum: " + (customer.name || customer.email), [["Member", (customer.name || "") + " · " + customer.email], ["Plan", planLabel(m.type, m.freq, m.size)], ["Payments left", String(MEM.minPayments - m.payments_made)]]);
    return { message: "Got it. You'll keep your visits. Your last " + (MEM.minPayments - m.payments_made === 1 ? "monthly payment goes" : (MEM.minPayments - m.payments_made) + " monthly payments go") + " through as usual, and then your membership ends automatically." };
  }
  if (mode === "now") {
    const remaining = MEM.minPayments - m.payments_made, fee = Math.round(MEM.cancelFeeRate * remaining * m.monthly_cents / 100) * 100, tax = 0, total = fee;   // no sales tax on cancellation fees
    const card = customer.card ? JSON.parse(customer.card) : null;
    if (!card) throw new Error("Add a card first so we can charge the cancellation fee.");
    const p = await charge(env, { source: card.id, amount: total, customerId: customer.square_customer_id, reference: "MEM-" + m.id.slice(0, 8), note: "Apex Membership early cancellation fee · " + money(fee) + " (no sales tax)", email: customer.email, idem: "memfee-" + m.id });
    await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, status, payment_id, receipt_url, for_day, created_at) VALUES (?, ?, 'cancel_fee', ?, ?, 'paid', ?, ?, ?, ?)").bind(rid(), m.id, fee, tax, p.id, p.receipt, today, Date.now()).run();
    const ends = m.period_end && m.period_end > today ? addDays(m.period_end, -1) : today;
    await upd(env, m.id, { status: ends > today ? "ending" : "cancelled", cancel_mode: "now", ends_on: ends, cancel_requested_at: Date.now() });
    await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "cancel_fee", { fee, tax, ends, card });
    await notifyNick(env, "Membership cancelled now (fee charged): " + (customer.name || customer.email), [["Member", (customer.name || "") + " · " + customer.email], ["Plan", planLabel(m.type, m.freq, m.size)], ["Fee", money(fee) + " (no sales tax)"], ["Visits paid through", ends > today ? niceDay(ends) : "today"]]);
    return { message: "Cancelled. We charged the " + money(fee) + " cancellation fee to your " + card.brand + " ending " + card.last4 + ". No more monthly charges." + (ends > today ? " You can still use visits you've already paid for through " + niceDay(ends) + "." : "") };
  }
  throw new Error("Pick how you'd like to cancel.");
}

export async function pauseMembership(env, m, months) {
  months = Math.max(1, Math.min(3, +months || 1));
  if (!(m.status === "active" && m.payments_made >= MEM.minPayments)) throw new Error("You can pause after your first 3 months.");
  const resume = addMonths(m.start_day, monthsBetween(m.start_day, m.next_bill) + months);
  await upd(env, m.id, { status: "paused", pause_until: resume, next_bill: resume });
  return { message: "Paused. You can still use visits you've paid for through " + (m.period_end ? niceDay(addDays(m.period_end, -1)) : "today") + ". Your next charge is " + niceDay(resume) + ", at the same price." };
}

// ---------- owner (dashboard) actions ----------
// Nick cancels with no early-cancellation fee: paid visits still count, no more charges.
export async function cancelWaived(env, m, customer) {
  const today = todayNY().key;
  if (m.status === "cancelled") throw new Error("Already cancelled.");
  if (m.status === "pending" || m.payments_made === 0 || m.payments_made >= MEM.minPayments) return cancelMembership(env, m, "", customer);   // no fee on these paths anyway
  const ends = m.period_end && m.period_end > today ? addDays(m.period_end, -1) : today;
  await upd(env, m.id, { status: ends > today ? "ending" : "cancelled", cancel_mode: "waived", ends_on: ends, cancel_requested_at: Date.now() });
  await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "cancelled", { ends });
  return { message: "Cancelled with no fee. No more charges" + (ends > today ? "; paid visits run through " + niceDay(ends) : "") + "." };
}
// Nick can pause any active membership (members themselves can only pause after the minimum)
export async function pauseByOwner(env, m, months) {
  months = Math.max(1, Math.min(6, Math.round(+months) || 1));
  if (m.status !== "active") throw new Error("Only an active membership can be paused.");
  const resume = addMonths(m.start_day, monthsBetween(m.start_day, m.next_bill || todayNY().key) + months);
  await upd(env, m.id, { status: "paused", pause_until: resume, next_bill: resume });
  await mail(env, m, "paused", { resume, through: m.period_end && m.period_end > todayNY().key ? addDays(m.period_end, -1) : null });
  return { message: "Paused. No charges until " + niceDay(resume) + "." };
}
export async function resumeByOwner(env, m) {
  if (m.status !== "paused") throw new Error("It isn't paused.");
  const today = todayNY().key, n = monthsBetween(m.start_day, today); let next = addMonths(m.start_day, n); if (next < today) next = addMonths(m.start_day, n + 1);
  if (m.period_end && m.period_end > next) next = m.period_end;   // the current month is already paid: next charge after it
  await upd(env, m.id, { status: "active", pause_until: null, next_bill: next });
  await mail(env, m, "resumed", { next });
  return { message: "Resumed. Next charge " + niceDay(next) + "." };
}
// new plan, frequency or car size: the new price starts with the next monthly charge
export async function changePlan(env, m, type, freq, size) {
  freq = +freq; size = +size;
  if (!MEM.plans[type] || ![1, 2, 4].includes(freq) || ![0, 1, 2].includes(size)) throw new Error("Pick a plan, how often and the car size.");
  if (m.status === "cancelled") throw new Error("This membership is cancelled.");
  const p = planPrice(type, size, freq);
  await upd(env, m.id, { type, freq, size, monthly_cents: p.monthly * 100 });
  await saveWinter(env, m.id, type, size, freq);
  await delMeta(env, "memup:" + m.id); await delMeta(env, "memdisc:" + m.id);   // a new plan replaces any waiting upgrade
  await mail(env, Object.assign({}, m, { type, freq, size, monthly_cents: p.monthly * 100 }), "plan_changed", { next: m.next_bill });
  return { message: "Changed to " + planLabel(type, freq, size) + " at $" + p.monthly + "/mo + tax, starting with the next charge.", monthly: p.monthly };
}

// ---------- meta helpers ----------
const getMeta = async (env, k) => { const r = await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first().catch(() => null); return r ? r.v : null; };
const setMeta = (env, k, v) => env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(k, String(v)).run();
const delMeta = (env, k) => env.DB.prepare("DELETE FROM meta WHERE k = ?").bind(k).run();
const jsonMeta = async (env, k) => { const v = await getMeta(env, k); try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
const liveMembers = async env => (await env.DB.prepare("SELECT m.*, c.email, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.status != 'cancelled'").all()).results || [];
const nameOf = m => m.name || m.email;

// ---------- upgrade: Interior → Wash + interior (Nick, Nov 3) ----------
// Like signing up, it starts after an Exterior or Full Detail (clean slate for the outside). It takes effect with the first
// charge on or after that detail, and that first upgraded month is MEM.upgradePct off. Waits in meta('memup:<id>');
// the discount waits in meta('memdisc:<id>') until a full-price month is paid.
const upgradeFirst = monthly => round5(monthly * (1 - MEM.upgradePct));
const getUpgrade = (env, id) => jsonMeta(env, "memup:" + id);
// the detail an upgrade can start from: the latest Exterior/Full Detail in the last 14 days, else the next upcoming one
async function upgradeDetail(env, customerId, today) {
  const r = (await env.DB.prepare("SELECT id, day, pkg FROM bookings WHERE customer_id = ? AND kind != 'member' AND status = 'confirmed' AND pkg IN ('exterior','full') AND custom_name IS NULL AND day >= ? ORDER BY day, start_utc")
    .bind(customerId, addDays(today, -MEM.signupDays)).all()).results || [];
  const past = r.filter(b => b.day <= today); return past.length ? past[past.length - 1] : r[0] || null;
}
async function upgradeInfo(env, m, today) {
  if (m.type !== "int" || !["active", "pending"].includes(m.status)) return null;
  const up = await getUpgrade(env, m.id), label = planLabel("both", m.freq, m.size);
  if (up) return { to: "both", label, monthly: up.monthly, first: up.first, pct: up.pct || 0, pending: { day: up.day, pkg: up.pkg, bill: firstOpenBill(m, up.day) } };
  const p = planPrice("both", m.size, m.freq), d = await upgradeDetail(env, m.customer_id, today), pct = (await joinedInWinter(env, m)) ? MEM.upgradePct : 0;
  return { to: "both", label, monthly: p.monthly, first: pct ? upgradeFirst(p.monthly) : p.monthly, pct, winter: winterDay(today), pending: null,
    detail: d ? { day: d.day, pkg: d.pkg, bill: firstOpenBill(m, d.day) } : null };
}
export async function startUpgrade(env, m, customer, auth) {
  if (m.type !== "int") throw new Error("Upgrades are from the Interior plan.");
  if (!["active", "pending"].includes(m.status)) throw new Error(m.status === "past_due" ? "Update your card and retry your last payment first." : "Your membership can't be upgraded right now. Text us at (732) 206-7084.");
  if (await getUpgrade(env, m.id)) throw new Error("Your upgrade is already set.");
  if (!customer.card) throw new Error("Add a card first (My details → Payment card).");
  const today = todayNY().key, d = await upgradeDetail(env, m.customer_id, today);
  if (!d) throw new Error("Book an Exterior Detail first. The upgrade starts after it.");
  const p = planPrice("both", m.size, m.freq), bill = firstOpenBill(m, d.day), pct = (await joinedInWinter(env, m)) ? MEM.upgradePct : 0;
  const up = { to: "both", booking: d.id, day: d.day, pkg: d.pkg, monthly: p.monthly, first: pct ? upgradeFirst(p.monthly) : p.monthly, pct, at: auth.at, ip: auth.ip, version: auth.version };
  await setMeta(env, "memup:" + m.id, JSON.stringify(up));
  const who = Object.assign({}, m, { email: customer.email, name: customer.name }), what = d.pkg === "full" ? "Full Detail" : "Exterior Detail";
  await mail(env, who, "upgrade_set", { up, bill });
  await notifyNick(env, "Membership upgrade: " + nameOf(who), [["Member", (customer.name || "") + " · " + customer.email], ["From", planLabel(m.type, m.freq, m.size)], ["To", planLabel("both", m.freq, m.size)],
    ["Starts after", what + " on " + niceDay(d.day)], ["First upgraded charge", niceDay(bill) + " · " + money(up.first * 100) + " + tax" + (pct ? " (" + Math.round(pct * 100) + "% off, joined in winter), then " + money(up.monthly * 100) + "/mo + tax" : "")]]);
  return { message: "Upgrade set. After your " + what + " on " + niceDay(d.day) + ", your plan becomes Wash + interior. Your first upgraded charge on " + niceDay(bill) + " is $" + up.first + " + tax" + (pct ? " (" + Math.round(pct * 100) + "% off), then $" + up.monthly + "/mo + tax." : ".") };
}
export async function cancelUpgrade(env, m) {
  if (!(await getUpgrade(env, m.id))) throw new Error("There's no upgrade to cancel.");
  await delMeta(env, "memup:" + m.id);
  return { message: "Upgrade cancelled. Your plan stays Interior." };
}
// the detail an upgrade waits for was cancelled or moved (called with every one-off booking change)
async function upgradesFor(env, bookingId) {
  const r = (await env.DB.prepare("SELECT k, v FROM meta WHERE k LIKE 'memup:%'").all()).results || [], out = [];
  for (const x of r) { let up; try { up = JSON.parse(x.v); } catch (e) { continue; } if (up && up.booking === bookingId) out.push({ id: x.k.slice(6), up }); }
  return out;
}
async function dropUpgrades(env, bookingId) {
  for (const { id, up } of await upgradesFor(env, bookingId)) {
    await delMeta(env, "memup:" + id);
    const m = await env.DB.prepare("SELECT m.*, c.email, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.id = ?").bind(id).first();
    if (m && m.status !== "cancelled") { await mail(env, m, "upgrade_dropped", { up }); await notifyNick(env, "Membership upgrade cancelled with its detail: " + nameOf(m), [["Member", nameOf(m)], ["Plan", "Stays " + planLabel(m.type, m.freq, m.size)]]); }
  }
}
async function moveUpgrades(env, booking) {
  for (const { id, up } of await upgradesFor(env, booking.id)) await setMeta(env, "memup:" + id, JSON.stringify(Object.assign(up, { day: booking.day })));
}

// ---------- winter starts or ends (Settings → Winter mode) ----------
// Wash + interior / Wash members get a heads-up 7 days before each change (once per change date) and an email on the day.
// On the day winter starts, the rest of the month they've paid for is made fair: Wash visits left are credited in full (and
// visits booked on winter days are cancelled); Wash + interior visits become interior visits and the price difference is
// credited. When winter ends, the full plan comes back with their next charge, and Interior members who joined during the
// winter get the upgrade offer. The current season is kept in meta('memseason') = { state: "winter"|"open", since }.
async function winterStartAdjust(env, m, today, H) {
  if (m.type === "int" || !m.period_start || !(m.period_start <= today && today < m.period_end) || !["active", "ending", "paused", "past_due"].includes(m.status)) return null;
  if (m.period_type === "int" || m.period_type === "off") return null;   // already interior / already credited
  const rows = (await env.DB.prepare("SELECT * FROM bookings WHERE membership_id = ? AND kind = 'member' AND day >= ? AND day < ?").bind(m.id, m.period_start, m.period_end).all()).results || [];
  // used = had, skipped or cancelled (those already earned their credit), or today's (may be underway); unused = confirmed and later
  const left = Math.max(0, m.freq - rows.filter(v => v.status !== "confirmed" || v.day <= today).length), later = rows.filter(v => v.day > today && v.status === "confirmed");
  const val = m.period_visit_cents || Math.round(m.monthly_cents / m.freq), changed = [];
  let per;
  if (m.type === "wash") {
    per = val;
    for (const v of later) {
      await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(Date.now(), v.id).run();
      if (H && H.deleteJob) await H.deleteJob(v.cal_href).catch(() => {});
      changed.push({ day: v.day, start: v.start_utc, what: "cancelled" });
    }
    await upd(env, m.id, { period_type: "off" });
  } else {
    const iv = Math.round((await coverCents(env, m, "int")) / m.freq); per = Math.max(0, val - iv);
    for (const v of later) {
      const end = v.start_utc + jobMin("interior", m.size, ["_member"]) * 60000;
      await env.DB.prepare("UPDATE bookings SET pkg = 'interior', end_utc = ?, visit_value_cents = ? WHERE id = ?").bind(end, iv, v.id).run();
      if (H && H.calSave) await H.calSave(Object.assign({}, v, { pkg: "interior", end_utc: end, visit_value_cents: iv })).catch(() => {});
      changed.push({ day: v.day, start: v.start_utc, what: "interior" });
    }
    await upd(env, m.id, { period_type: "int", period_visit_cents: iv });
  }
  const credit = per * left, refund = !billsAgain(m);   // no next charge to take a credit off: Nick refunds it in Square
  if (credit > 0 && !refund) await env.DB.prepare("UPDATE memberships SET credit_cents = credit_cents + ?, updated_at = ? WHERE id = ?").bind(credit, Date.now(), m.id).run();
  return { credit, left, changed, refund };
}
async function seasonOf(env, today, W) {
  const P = await jsonMeta(env, "memseason");
  return P && P.state ? P : { state: winterWith(W, today) ? "winter" : "open", since: seasonStart(today, W) || today, fresh: true };
}
// who a change emails: winter start/end → Wash and Wash + interior members; winter end also → Interior members who joined in winter
// (a membership that's ending without another charge only gets the winter-start email, about its visits and refund)
function seasonAudience(live, kind, since) {
  return live.filter(m => (kind === "start" || billsAgain(m)) && (m.type !== "int" || (kind === "end" && utcToNy(m.created_at).key >= since)));
}
export async function seasonTick(env, today, H) {
  const log = [], W = RULES.winter, S = winterWith(W, today) ? "winter" : "open", P = await seasonOf(env, today, W);
  if (P.fresh) { await setMeta(env, "memseason", JSON.stringify({ state: P.state, since: P.since })); return log; }   // first run: remember the season, no emails
  const live = await liveMembers(env);
  if (P.state !== S) {
    const kind = S === "winter" ? "start" : "end", sent = [];
    for (const m of seasonAudience(live, kind, P.since)) {
      const key = "memsn:" + m.id + ":" + kind + ":" + today;
      if (await getMeta(env, key)) continue;
      await setMeta(env, key, "1");
      try {
        if (kind === "start") {
          const adj = await winterStartAdjust(env, m, today, H), ends = nextFlip(today, 400, W);
          await mail(env, m, "winter_start", { adj, ends, back: ends ? billOnOrAfter(m, ends) : null, intMonthly: m.type === "both" ? await coverCents(env, m, "int") : 0 });
          sent.push([nameOf(m), planLabel(m.type, m.freq, m.size) + (adj && adj.credit ? (adj.refund ? " · REFUND " + money(adj.credit) + " in Square (membership ending, no next charge)" : " · " + money(adj.credit) + " credit") : "") + (adj && adj.changed.length ? " · " + adj.changed.length + " booked visit" + (adj.changed.length > 1 ? "s" : "") + (m.type === "wash" ? " cancelled" : " made interior") : "")]);
        } else if (m.type !== "int") {
          const back = billOnOrAfter(m, today);
          await mail(env, m, "winter_end", { back });
          sent.push([nameOf(m), planLabel(m.type, m.freq, m.size) + " · full plan from " + niceDay(back)]);
        } else if (!(await getUpgrade(env, m.id))) {
          await setMeta(env, "memwj:" + m.id, "1");   // they joined this winter: the offer's discount holds
          await mail(env, m, "upgrade_offer", {});
          sent.push([nameOf(m), planLabel(m.type, m.freq, m.size) + " · upgrade offer"]);
        }
      } catch (e) { log.push(m.id + " season error " + e.message); }
    }
    await setMeta(env, "memseason", JSON.stringify({ state: S, since: today }));
    if (sent.length) await notifyNick(env, "Winter mode " + (kind === "start" ? "started" : "ended") + ": " + sent.length + " member email" + (sent.length > 1 ? "s" : ""), sent);
    log.push("season " + kind + " (" + sent.length + " emailed)");
  }
  const F = nextFlip(today, 7, W);   // heads-up, once per change date
  if (F) {
    const kind = S === "winter" ? "end" : "start", hk = "memheads:" + kind + ":" + F;
    if (!(await getMeta(env, hk))) {
      await setMeta(env, hk, today); const sent = [];
      for (const m of live.filter(x => x.type !== "int" && billsAgain(x))) {
        try {
          await mail(env, m, kind === "start" ? "winter_soon" : "winter_over_soon", { day: F, ends: kind === "start" ? nextFlip(F, 400, W) : null, back: kind === "end" ? billOnOrAfter(m, F) : null, intMonthly: m.type === "both" ? await coverCents(env, m, "int") : 0 });
          sent.push([nameOf(m), planLabel(m.type, m.freq, m.size)]);
        } catch (e) { log.push(m.id + " heads-up error " + e.message); }
      }
      if (sent.length) await notifyNick(env, "Winter mode heads-up: " + sent.length + " member" + (sent.length > 1 ? "s" : "") + " emailed", [["Change", (kind === "start" ? "Winter starts " : "Winter ends ") + niceDay(F)]].concat(sent));
      log.push("heads-up " + kind + " " + F + " (" + sent.length + ")");
    }
  }
  return log;
}
// for the dashboard, before Nick saves new winter dates: who would be emailed today / in the next 7 days
export async function seasonImpact(env, W) {
  const today = todayNY().key, S = winterWith(W, today) ? "winter" : "open", P = await seasonOf(env, today, RULES.winter), live = await liveMembers(env), out = { now: null, soon: null };
  if (!P.fresh && P.state !== S) { const kind = S === "winter" ? "start" : "end"; out.now = { kind, count: seasonAudience(live, kind, P.since).length }; }
  const F = nextFlip(today, 7, W);
  if (F) { const kind = S === "winter" ? "end" : "start"; if (!(await getMeta(env, "memheads:" + kind + ":" + F))) out.soon = { kind, day: F, count: live.filter(x => x.type !== "int" && billsAgain(x)).length }; }
  return out;
}
export const mailMember = (env, m, kind, o) => mail(env, m, kind, o);

// ---------- emails ----------
// welcome email for a membership started from the account (at booking, the booking email covers it)
export async function mailWelcome(env, id, info, card) {
  const m = await env.DB.prepare("SELECT m.*, c.email, c.name FROM memberships m JOIN customers c ON c.id = m.customer_id WHERE m.id = ?").bind(id).first();
  if (m) await mail(env, m, "welcome", { firstBill: info && info.firstBill, firstAmount: info && info.firstAmount, card });
}
export const previewMail = (env, m, kind, o) => mail(env, m, kind, o);   // dev preview only (/api/dev/emails)
async function mail(env, m, kind, o) {
  o = o || {};
  const c = m.email ? m : await env.DB.prepare("SELECT email, name FROM customers WHERE id = ?").bind(m.customer_id).first();
  const first = (c.name || "").split(" ")[0] || "there", site = env.SITE_URL, acct = site + "/#account", label = planLabel(m.type, m.freq, m.size), AM = am(site);
  const b = s => `<b style="color:#f5f5f5">${s}</b>`;
  const T = {
    // new: confirms the plan, the price, when billing starts and how to cancel (sent when it's started from the account; at booking it's in the booking email)
    welcome: () => ["You're an Apex member: " + label, "Your plan, your first charge, and how it works.",
      hero("Welcome to Apex Membership", `You're in, ${h(first)}.`, `Your ${AM} keeps your car where your detail left it. Here's your plan.`) +
      rows([["Plan", label], ["Monthly", money(m.monthly_cents) + " + " + money(taxCents(m.monthly_cents)) + " tax = " + money(m.monthly_cents + taxCents(m.monthly_cents))], ["First charge", o.firstBill ? niceDay(o.firstBill) + (o.firstAmount != null ? " · " + money(Math.round(o.firstAmount * 100) + taxCents(Math.round(o.firstAmount * 100))) : "") : ""],
        ["Minimum", MEM.minPayments + " monthly payments, then pause or cancel anytime"], ["Card", o.card ? o.card.brand + " ending " + o.card.last4 : "Add one in your account within 14 days of your detail"]]) +
      para("Once each month is paid, you pick that month's visit times in your account. Members get priority weekends, 10% off add-ons and no travel fee on visits.") +
      buttons([[acct, "Open my account"]]) + note(`Billed to your card on the same date every month, plus NJ sales tax. Cancel in your account: free before your first charge; during the first ${MEM.minPayments} months you can finish them out or cancel early for a fee of half the payments left. <a href="${h(site)}/membership-terms" style="color:#f5f5f5">Membership Terms</a>`)],
    receipt: () => ["Apex Membership receipt · " + money(o.amount + (o.tax || 0)), "Paid for this month. Pick your visit times anytime.",
      hero("Receipt", `Thanks, ${h(first)}!`, `Your ${AM} is paid for this month. Pick your visit times in your account.`) +
      rows([["Plan", label], ["Period", niceDay(o.period[0]) + " – " + niceDay(addDays(o.period[1], -1))], ["Visits", m.freq + (o.cover !== m.type ? " (" + MEM.plans[o.cover].name + " visits for winter)" : "")], ["Membership", money(o.amount) + (o.credit ? " (" + money(o.credit) + " credit used)" : "")], ["Upgrade discount", o.disc ? Math.round(o.disc * 100) + "% off your first Wash + interior month (" + money(o.listed) + " → " + money(o.full) + ")" : ""], [TAX_LABEL, money(o.tax || 0)], ["Charged", money(o.amount + (o.tax || 0)), false, "total"], ["Card", o.card ? o.card.brand + " ending " + o.card.last4 : ""], ["Last month", o.last ? "Your membership ends " + niceDay(o.last) : ""]]) +
      buttons([[acct, "Pick my visit times"], o.receipt ? [o.receipt, "Square receipt", "secondary"] : null])],
    fail: () => ["Action needed: your Apex Membership payment didn't go through", "Please update your card so your visits keep going.",
      hero("Action needed", "Your payment didn't go through.", `We couldn't charge ${b(money(o.amount))} for your ${AM}. Please update your card in your account. We'll try again on ${b(niceDay(o.retry || ""))}.`) +
      para("Visits are paused until it's paid.") + buttons([[acct, "Update my card"]])],
    fail_final: () => ["Your Apex Membership was cancelled", "We couldn't charge your card, so the membership was cancelled.",
      hero("Membership cancelled", "Your membership was cancelled.", `We tried several times but couldn't charge ${b(money(o.amount))} for your ${AM}, so it's been cancelled. That amount is still owed.`) +
      para("Reply to this email or text (732) 206-7084 and we'll sort it out together.")],
    card_needed: () => ["Add a card to start your Apex Membership", "One step left: add a card in your account.",
      hero("One step left", `Add your card, ${h(first)}.`, `Your ${h(label)} ${AM} needs a card on file. Add one in your account by ${b(niceDay(o.deadline))}, or the membership won't start.`) +
      para("Your first charge is one month after your detail.") + buttons([[acct, "Add my card"]])],
    nocard_cancel: () => ["Your Apex Membership didn't start", "No card was added, so you won't be charged.",
      hero("Membership", "Your membership didn't start.", `We didn't get a card within 14 days of your detail, so your ${AM} wasn't started and you won't be charged.`) +
      para("You can start one after your next qualifying detail.") + buttons([[site + "/#book", "Book a detail"]])],
    cancelled: () => ["Your Apex Membership is cancelled", "No more monthly charges.",
      hero("Membership cancelled", "You're cancelled.", `No more monthly charges. Your ${AM} stays active through ${b(niceDay(o.ends))}, so keep using any visits you've booked.`) +
      para("We'd love to have you back anytime.") + buttons([[site + "/#book", "Book a detail", "secondary"]])],
    finishing: () => ["Your Apex Membership will end after your 3rd month", "You keep your visits until then. No fee.",
      hero("Membership", `Got it, ${h(first)}.`, `You'll keep your visits, and the remaining ${o.left} monthly payment${o.left === 1 ? "" : "s"} in your first 3 months will go through as usual. Your ${AM} ends automatically after that. No fee.`) +
      buttons([[acct, "My membership"]])],
    cancelled_free: () => ["Your Apex Membership is cancelled", "You weren't charged, and you won't be.",
      hero("Membership cancelled", "You're cancelled.", `Your ${h(label)} ${AM} is cancelled. You haven't been charged for it and you won't be.`) +
      para("Your detail booking itself isn't affected.")],
    detail_cancelled: () => ["Your Apex Membership was cancelled with your detail", "Your detail was cancelled, so the membership was too. No charge.",
      hero("Membership cancelled", "Your membership was cancelled too.", `Your ${h(label)} ${AM} starts after your first detail, and that detail was cancelled${o.byUs ? " on our side" : ""}, so the membership was cancelled too. You weren't charged.`) +
      para(o.byUs ? "When you book your new time, you can add the membership again from your account." : "You can add it again when you book your next detail.") + buttons([[acct, "Go to my account"]])],
    paused: () => ["Your Apex Membership is paused", "No charges until " + niceDay(o.resume) + ".",
      hero("Membership paused", "You're paused.", `Your ${AM} is paused. No charges until ${b(niceDay(o.resume))}, then it picks up at the same price.`) +
      (o.through ? para("You can still use visits you've already paid for through " + b(niceDay(o.through)) + ".") : "") + buttons([[acct, "My membership"]])],
    resumed: () => ["Your Apex Membership is back on", "Your next charge is " + niceDay(o.next) + ".",
      hero("Membership resumed", `Welcome back, ${h(first)}.`, `Your ${AM} is active again. Your next charge is ${b(niceDay(o.next))}: ${b(money(m.monthly_cents))} + tax. Once it's paid, pick your visit times in your account.`) +
      buttons([[acct, "My membership"]])],
    plan_changed: () => ["Your Apex Membership plan changed", "New plan: " + label + ".",
      hero("Plan updated", "Your plan changed.", `Your ${AM} is now ${b(h(label))} at ${b(money(m.monthly_cents))}/mo + tax, starting with your next charge${o.next ? " on " + b(niceDay(o.next)) : ""}.`) +
      para("Questions? Just reply to this email.") + buttons([[acct, "My membership"]])],

    // winter mode (Settings dates): heads-up 7 days before, then on the day
    winter_soon: () => { const wash = m.type === "wash";
      return ["Winter mode starts " + niceDay(o.day) + ": your Apex Membership", wash ? "Your Wash plan pauses from " + niceDay(o.day) + ". No charges while it's paused." : "From " + niceDay(o.day) + " your visits are interior-only, at the Interior price.",
      hero("Winter mode", "Heads-up: winter starts " + h(niceDay(o.day)) + ".", `It gets too cold to wash outside (water freezes on the paint and sealant won't cure), so we only do interior work from ${b(niceDay(o.day))}${o.ends ? " until " + b(niceDay(o.ends)) : ""}. Here's what happens to your ${AM}.`) +
      (wash ? para(`Your ${b("Wash plan pauses")} during winter. No charges while it's paused, and paused time doesn't count toward your 3-month minimum. Any visits left in the month you've already paid for are credited in full, and Wash visits you've booked for the rest of that month are cancelled.`)
        : para(`Your visits become ${b("interior visits")}, billed at the Interior price: ${b(money(o.intMonthly))}/mo + tax instead of ${money(m.monthly_cents)}. For the month you've already paid for, the difference on visits you haven't had yet comes off your next charge, and booked visits switch to interior visits.`)) +
      para("Nothing to do on your end. We'll email you again when winter starts and when your full plan is back.") + buttons([[acct, "My membership"]]) + note(`<a href="${h(site)}/membership-terms#winter" style="color:#f5f5f5">Membership Terms §6: Winter</a>`)]; },
    winter_start: () => { const wash = m.type === "wash", A = o.adj || {}, ch = A.changed || [];
      const list = ch.length ? rows(ch.map(c => [niceDay(c.day), c.what === "cancelled" ? "Cancelled (credited)" : "Now an interior visit"])) : "";
      return ["Your Apex Membership switched to winter mode", wash ? "Your Wash plan is paused for winter. No charges until it's back." : "Interior visits at the Interior price until winter's over.",
      hero("Winter mode", wash ? "Your Wash plan is paused." : "Interior visits for winter.", `Winter started, so we only do interior work${o.ends ? " until " + b(niceDay(o.ends)) : ""} (it's too cold to wash outside). Your ${AM} changed automatically.`) +
      rows([["Plan", label], ["Winter", wash ? "Paused, no charges" : "Interior visits at " + money(o.intMonthly) + "/mo + tax"], [A.refund ? "Refund" : "Credit", A.credit ? (A.refund ? money(A.credit) + " back to your card within a few days" : money(A.credit) + " off your next charge, before tax") + " (" + A.left + " visit" + (A.left === 1 ? "" : "s") + " left this month)" : ""], ["Full plan back", o.back && billsAgain(m) ? "With your charge on " + niceDay(o.back) + " (" + money(m.monthly_cents) + " + tax)" : ""]]) +
      (list ? para(wash ? "These booked visits were cancelled:" : "These booked visits are now interior visits:") + list : "") +
      buttons([[acct, "My membership"]]) + note(`<a href="${h(site)}/membership-terms#winter" style="color:#f5f5f5">Membership Terms §6: Winter</a>`)]; },
    winter_over_soon: () => ["Winter's almost over: your Apex Membership is back " + niceDay(o.day), "Your full " + MEM.plans[m.type].name + " plan comes back with your charge on " + niceDay(o.back) + ".",
      hero("Winter mode", "Heads-up: winter ends " + h(niceDay(o.day)) + ".", `Outside work is back on ${b(niceDay(o.day))}. Your ${AM} goes back to ${b(h(label))} with your charge on ${b(niceDay(o.back))}: ${b(money(m.monthly_cents))} + tax.`) +
      para(m.type === "wash" ? "Once that charge goes through, pick your Wash visit times in your account." : "Until then, visits in the month you've already paid for stay interior visits.") + buttons([[acct, "My membership"]])],
    winter_end: () => ["Your Apex Membership is back: " + label, "Your full plan comes back with your charge on " + niceDay(o.back) + ".",
      hero("Winter's over", `Your plan is back, ${h(first)}.`, `Outside work is back. Your ${AM} returns to ${b(h(label))} with your charge on ${b(niceDay(o.back))}: ${b(money(m.monthly_cents))} + ${money(taxCents(m.monthly_cents))} tax.`) +
      para(m.type === "wash" ? "Once it goes through, pick your Wash visit times in your account." : "Visits in the month you've already paid for stay interior visits until then.") + buttons([[acct, "My membership"]])],
    upgrade_offer: () => { const P2 = planPrice("both", m.size, m.freq), f1 = upgradeFirst(P2.monthly);
      return ["All Apex Membership plans are open again", "Upgrade to Wash + interior: your first month is " + Math.round(MEM.upgradePct * 100) + "% off.",
      hero("Winter's over", `Every plan is open again, ${h(first)}.`, `You joined in winter, when only the Interior plan could start. Now that outside work is back, you can upgrade your ${AM} to ${b("Wash + interior")}.`) +
      rows([["Now", label + " · " + money(m.monthly_cents) + "/mo"], ["Upgrade to", planLabel("both", m.freq, m.size) + " · " + money(P2.monthly * 100) + "/mo"], ["First upgraded month", money(f1 * 100) + " + tax (" + Math.round(MEM.upgradePct * 100) + "% off)"]]) +
      para("It starts after an Exterior Detail, so your car's outside starts from a clean slate too. Book it, then tap Upgrade in your account. Your plan switches with your first charge after that detail.") +
      buttons([[site + "/#book", "Book an Exterior Detail"], [acct, "Upgrade in my account", "secondary"]]) + note("Prices are before NJ sales tax. The upgrade is optional; your Interior plan keeps going as it is.")]; },
    upgrade_set: () => { const what = o.up.pkg === "full" ? "Full Detail" : "Exterior Detail";
      return ["Your Apex Membership upgrade is set", "Wash + interior starts with your charge on " + niceDay(o.bill) + ".",
      hero("Upgrade", `You're upgrading, ${h(first)}.`, `After your ${h(what)} on ${b(niceDay(o.up.day))}, your ${AM} becomes ${b("Wash + interior")}.`) +
      rows([["New plan", planLabel("both", m.freq, m.size)], ["First upgraded charge", niceDay(o.bill) + " · " + money(o.up.first * 100) + " + " + money(taxCents(o.up.first * 100)) + " tax" + (o.up.pct ? " (" + Math.round(o.up.pct * 100) + "% off)" : "")], ["After that", o.up.pct ? money(o.up.monthly * 100) + " + " + money(taxCents(o.up.monthly * 100)) + " tax a month" : "Same price every month"], ["Until then", "Your Interior plan carries on as usual"]]) +
      para(`If that ${h(what)} is cancelled, the upgrade is cancelled too and your Interior plan stays as it is. You can cancel the upgrade in your account before it starts.`) + buttons([[acct, "My membership"]]) +
      note(`You authorized Apex Detailing LLC to charge your card the Wash + interior price above on your usual billing date every month, as described in the <a href="${h(site)}/membership-terms" style="color:#f5f5f5">Membership Terms</a>. Your 3-month minimum doesn't restart.`)]; },
    upgrade_dropped: () => ["Your Apex Membership upgrade was cancelled", "The detail it was waiting for was cancelled, so your plan stays Interior.",
      hero("Upgrade cancelled", "Your plan stays Interior.", `Your upgrade to Wash + interior was waiting for your ${o.up && o.up.pkg === "full" ? "Full Detail" : "Exterior Detail"}${o.up && o.up.day ? " on " + b(niceDay(o.up.day)) : ""}, and that detail was cancelled. Your ${AM} carries on as ${b(h(label))}.`) +
      para("Book another Exterior Detail anytime, then tap Upgrade in your account.") + buttons([[site + "/#book", "Book an Exterior Detail"], [acct, "My membership", "secondary"]])],
    cancel_fee: () => ["Your Apex Membership is cancelled", "Cancelled. No more monthly charges.",
      hero("Membership cancelled", "You're cancelled.", `We charged the ${b(money(o.fee))} early cancellation fee to your ${h((o.card || {}).brand || "card")} ending ${h((o.card || {}).last4 || "")}. No more monthly charges.`) +
      (o.ends > todayNY().key ? para("You can still use visits you've already paid for through " + b(niceDay(o.ends)) + ".") : "") + buttons([[site + "/#book", "Book a detail", "secondary"]])]
  }[kind];
  if (!T) return;
  let R; try { R = T(); } catch (e) { console.log("membership email failed", kind, e.message); return; }
  return send(env, { to: c.email, subject: R[0], html: layout(R[0], R[2], R[1], site) }).catch(() => {});
}
