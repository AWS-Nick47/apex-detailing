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
const monthsBetween = (startKey, key) => { let n = 0; while (addMonths(startKey, n + 1) <= key) n++; return n; };
const todayNY = () => utcToNy(Date.now());
const winterDay = key => { const { y, m, d } = parseDay(key); return inWinter(y, m, d); };
function niceDay(key) { if (!key) return ""; const { y, m, d } = parseDay(key); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }); }

// What a visit covers on a given day (winter: wash pauses, wash + interior gets interior visits)
export function coverOn(type, key) { if (!winterDay(key)) return type; return type === "wash" ? null : type === "both" ? "int" : type; }

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
  const m = await env.DB.prepare("SELECT * FROM memberships WHERE qualifying_booking = ? AND status IN ('pending','active') AND payments_made = 0").bind(booking.id).first();
  if (!m) return null;
  const today = todayNY().key, first = addMonths(booking.day, 1);
  await upd(env, m.id, { start_day: booking.day, next_bill: first, status: booking.day <= today ? "active" : "pending", card_reminders: 0 });
  return { id: m.id, monthly: m.monthly_cents / 100, firstBill: first, label: planLabel(m.type, m.freq, m.size) };
}

// The first detail was cancelled: the membership can't start, so it's cancelled too (no charge yet) and both sides get an email. Audit IA-010.
export async function cancelWithDetail(env, booking, byUs) {
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
  const allowed = m.period_start && ["active", "ending", "paused"].includes(m.status) && today < m.period_end ? m.freq : 0;
  const remaining = Math.max(0, MEM.minPayments - m.payments_made);
  const fee = Math.round(MEM.cancelFeeRate * remaining * m.monthly_cents / 100) * 100;
  const qual = m.start_day, cardDeadline = addDays(qual, MEM.signupDays);
  // the next charge as billOne() will make it: winter may pause Wash or bill Wash + interior at the Interior price; credits come off before tax
  const cov = m.next_bill ? coverOn(m.type, m.next_bill) : m.type, nextFull = cov === null ? 0 : cov === m.type ? m.monthly_cents : planPrice(cov, m.size, m.freq).monthly * 100;
  const nextSub = nextFull - Math.min(m.credit_cents, nextFull), nextTotal = nextSub + taxCents(nextSub);
  return {
    id: m.id, status: m.status, type: m.type, freq: m.freq, size: m.size, car: m.car, label: planLabel(m.type, m.freq, m.size), monthly: m.monthly_cents / 100,
    monthlyTax: taxCents(m.monthly_cents) / 100, monthlyTotal: (m.monthly_cents + taxCents(m.monthly_cents)) / 100, cancelFeeTax: 0, cancelFeeTotal: fee / 100, nextChargeTotal: nextTotal / 100, nextWinter: cov !== m.type,
    since: m.start_day, nextBill: m.status === "cancelled" || (m.status === "ending" && !(m.cancel_mode === "finish" && m.payments_made < MEM.minPayments)) ? null : m.next_bill, periodStart: m.period_start, periodEnd: m.period_end,
    paymentsMade: m.payments_made, minLeft: remaining, cancelFee: fee / 100, credit: m.credit_cents / 100, owed: m.owed_cents / 100, endsOn: m.ends_on, cancelMode: m.cancel_mode, pauseUntil: m.pause_until,
    needsCard: !card, cardDeadline, card: card ? card.brand + " ending " + card.last4 : null,
    visitsAllowed: allowed, visitsBooked: inPeriod.length, coverNow: m.period_type || coverOn(m.type, today),
    winterNow: winterDay(today),
    upcoming: list.filter(v => v.status === "confirmed" && v.end_utc > Date.now()).map(v => ({ id: v.id, start: v.start_utc, end: v.end_utc, day: v.day, pkg: v.pkg, manage: env.SITE_URL + "/b/" + v.token })),
    canPause: m.status === "active" && m.payments_made >= MEM.minPayments
  };
}

// ---------- open times for a member visit (current paid period only) ----------
export async function visitSlots(env, m, H) {
  const today = todayNY().key;
  if (!m.period_start || !["active", "ending", "paused"].includes(m.status) || today >= m.period_end) return { days: [], reason: m.status === "past_due" ? "Your last payment didn't go through. Update your card to book visits." : m.status === "paused" ? "Your membership is paused." : m.status === "pending" || !m.period_start ? "You can book visits once your first month is paid, one month after your detail." : "Your next month isn't paid yet." };
  const booked = await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE membership_id = ? AND kind = 'member' AND day >= ? AND day < ?").bind(m.id, m.period_start, m.period_end).first();
  if (booked.n >= m.freq) return { days: [], reason: "You've used all " + m.freq + " visit" + (m.freq > 1 ? "s" : "") + " for this month." };
  const cover = m.period_type || m.type; const pkg = MEM.visitPkg[cover];
  let from = today > m.period_start ? today : m.period_start; const n = Math.min(35, Math.round((nyToUtc(m.period_end, 0) - nyToUtc(from, 0)) / 864e5));
  const info = await H.days(env, from, n), out = [];
  for (const k of Object.keys(info)) { if (k >= m.period_end) break; if (coverOn(m.type, k) === null) continue; const s = slotsFor(k, info[k], MEM.visitPkg[coverOn(m.type, k)], m.size, ["_member"], Date.now()); if (s.length) out.push({ day: k, label: niceDay(k), slots: s }); }
  return { days: out, pkg, left: m.freq - booked.n };
}

// ---------- monthly billing (runs from the cron) ----------
export async function runBilling(env) {
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
  if (now.min < MEM.billHour * 60) return log;
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
  const cover = coverOn(m.type, billDay);
  if (cover === null) {   // winter: wash plans pause, no charge, doesn't count toward the minimum
    await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, status, for_day, created_at) VALUES (?, ?, 'winter_skip', 0, 'skipped', ?, ?)").bind(rid(), m.id, billDay, Date.now()).run();
    await upd(env, m.id, { next_bill: addMonths(m.start_day, monthsBetween(m.start_day, billDay) + 1), period_start: null, period_end: null });
    return "winter pause";
  }
  const full = cover === m.type ? m.monthly_cents : planPrice(cover, m.size, m.freq).monthly * 100;
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
  } catch (e) { if (/UNIQUE/i.test(e.message)) return "already billed (another run got there first)"; throw e; }   // cron and "Retry payment" at once (audit IA-038)
  const made = m.payments_made + 1;
  const fields = { status: m.status === "past_due" ? "active" : m.status, payments_made: made, credit_cents: m.credit_cents - credit, fail_count: 0, retry_day: null, owed_cents: 0,
    period_start: billDay, period_end: periodEnd, period_visit_cents: Math.round(full / m.freq), period_type: cover, next_bill: periodEnd };
  if (m.cancel_mode === "finish" && made >= MEM.minPayments) { fields.status = "ending"; fields.ends_on = addDays(periodEnd, -1); }
  await upd(env, m.id, fields);
  await mail(env, m, "receipt", { amount, tax, credit, full, period: [billDay, periodEnd], cover, receipt: p && p.receipt, card, last: fields.ends_on });
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
      rows([["Plan", label], ["Period", niceDay(o.period[0]) + " – " + niceDay(addDays(o.period[1], -1))], ["Visits", m.freq + (o.cover !== m.type ? " (" + MEM.plans[o.cover].name + " visits for winter)" : "")], ["Membership", money(o.amount) + (o.credit ? " (" + money(o.credit) + " credit used)" : "")], [TAX_LABEL, money(o.tax || 0)], ["Charged", money(o.amount + (o.tax || 0)), false, "total"], ["Card", o.card ? o.card.brand + " ending " + o.card.last4 : ""], ["Last month", o.last ? "Your membership ends " + niceDay(o.last) : ""]]) +
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
    cancel_fee: () => ["Your Apex Membership is cancelled", "Cancelled. No more monthly charges.",
      hero("Membership cancelled", "You're cancelled.", `We charged the ${b(money(o.fee))} early cancellation fee to your ${h((o.card || {}).brand || "card")} ending ${h((o.card || {}).last4 || "")}. No more monthly charges.`) +
      (o.ends > todayNY().key ? para("You can still use visits you've already paid for through " + b(niceDay(o.ends)) + ".") : "") + buttons([[site + "/#book", "Book a detail", "secondary"]])]
  }[kind];
  if (!T) return;
  let R; try { R = T(); } catch (e) { console.log("membership email failed", kind, e.message); return; }
  return send(env, { to: c.email, subject: R[0], html: layout(R[0], R[2], R[1], site) }).catch(() => {});
}
