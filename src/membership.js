// Apex Membership: sign-up, monthly billing on the anniversary date, visits, skips/credits, pause, cancel.
// Rules are in public/membership-terms.html — keep the two in sync.
import { PRICING, TAX, taxCents } from "./pricing.js";
import { RULES, inWinter, parseDay, dayKey, addDays, utcToNy, nyToUtc, slotsFor, dayInfo, jobMin } from "./sched.js";
import { charge } from "./square.js";
import { send, layout, rows, button, h } from "./email.js";

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
  return { id, monthly: p.monthly, firstBill: addMonths(booking.day, 1), label: planLabel(type, +freq, booking.size) };
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
    monthlyTax: taxCents(m.monthly_cents) / 100, monthlyTotal: (m.monthly_cents + taxCents(m.monthly_cents)) / 100, cancelFeeTax: taxCents(fee) / 100, cancelFeeTotal: (fee + taxCents(fee)) / 100, nextChargeTotal: nextTotal / 100, nextWinter: cov !== m.type,
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
    if (m.bstatus === "cancelled") { await upd(env, m.id, { status: "cancelled", ends_on: today, cancel_mode: "detail_cancelled" }); log.push(m.id + " cancelled (detail cancelled)"); }
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

async function billOne(env, m, today) {
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
    if (!card) return failed(env, m, billDay, amount, credit, "No card on file");
    try { p = await charge(env, { source: card.id, amount: total, customerId: m.square_customer_id, reference: "MEM-" + m.id.slice(0, 8), note: "Apex Membership · " + planLabel(m.type, m.freq, m.size) + " · " + billDay + " · " + money(amount) + " + " + money(tax) + " " + TAX.name, email: m.email, idem: "mem-" + m.id + "-" + billDay + "-" + (m.fail_count || 0) }); }
    catch (e) { return failed(env, m, billDay, amount, credit, e.message); }
  }
  const periodEnd = addMonths(m.start_day, monthsBetween(m.start_day, billDay) + 1);
  await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, credit_used_cents, status, payment_id, receipt_url, for_day, created_at) VALUES (?, ?, 'monthly', ?, ?, ?, 'paid', ?, ?, ?, ?)")
    .bind(rid(), m.id, amount, tax, credit, p ? p.id : null, p ? p.receipt : null, billDay, Date.now()).run();
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
  return billOne(env, Object.assign({}, m, c), todayNY().key);
}

// ---------- cancel / pause ----------
export async function cancelMembership(env, m, mode, customer) {
  const today = todayNY().key;
  if (m.status === "cancelled") throw new Error("Already cancelled.");
  if (m.status === "pending" || m.payments_made === 0) {   // before the first monthly charge: free (no member benefits used yet)
    await upd(env, m.id, { status: "cancelled", ends_on: today, cancel_mode: "before_start", cancel_requested_at: Date.now() });
    return { message: "Your membership is cancelled. You won't be charged." };
  }
  if (m.payments_made >= MEM.minPayments) {
    const ends = m.period_end ? addDays(m.period_end, -1) : today;
    await upd(env, m.id, { status: "ending", cancel_mode: "after_min", ends_on: ends, cancel_requested_at: Date.now() });
    await mail(env, m, "cancelled", { ends });
    return { message: "Cancelled. No more charges. Your membership stays active through " + niceDay(ends) + "." };
  }
  if (mode === "finish") {
    await upd(env, m.id, { status: "ending", cancel_mode: "finish", cancel_requested_at: Date.now() });
    await mail(env, m, "finishing", { left: MEM.minPayments - m.payments_made });
    return { message: "Got it. You'll keep your visits. Your last " + (MEM.minPayments - m.payments_made === 1 ? "monthly payment goes" : (MEM.minPayments - m.payments_made) + " monthly payments go") + " through as usual, and then your membership ends automatically." };
  }
  if (mode === "now") {
    const remaining = MEM.minPayments - m.payments_made, fee = Math.round(MEM.cancelFeeRate * remaining * m.monthly_cents / 100) * 100, tax = taxCents(fee), total = fee + tax;
    const card = customer.card ? JSON.parse(customer.card) : null;
    if (!card) throw new Error("Add a card first so we can charge the cancellation fee.");
    const p = await charge(env, { source: card.id, amount: total, customerId: customer.square_customer_id, reference: "MEM-" + m.id.slice(0, 8), note: "Apex Membership early cancellation fee · " + money(fee) + " + " + money(tax) + " " + TAX.name, email: customer.email, idem: "memfee-" + m.id });
    await env.DB.prepare("INSERT INTO membership_charges (id, membership_id, kind, amount_cents, tax_cents, status, payment_id, receipt_url, for_day, created_at) VALUES (?, ?, 'cancel_fee', ?, ?, 'paid', ?, ?, ?, ?)").bind(rid(), m.id, fee, tax, p.id, p.receipt, today, Date.now()).run();
    const ends = m.period_end && m.period_end > today ? addDays(m.period_end, -1) : today;
    await upd(env, m.id, { status: ends > today ? "ending" : "cancelled", cancel_mode: "now", ends_on: ends, cancel_requested_at: Date.now() });
    await mail(env, Object.assign({}, m, { email: customer.email, name: customer.name }), "cancel_fee", { fee, tax, ends, card });
    return { message: "Cancelled. We charged the " + money(fee) + " cancellation fee plus " + money(tax) + " " + TAX.name + " (" + money(total) + ") to your " + card.brand + " ending " + card.last4 + ". No more monthly charges." + (ends > today ? " You can still use visits you've already paid for through " + niceDay(ends) + "." : "") };
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
async function mail(env, m, kind, o) {
  o = o || {};
  const c = m.email ? m : await env.DB.prepare("SELECT email, name FROM customers WHERE id = ?").bind(m.customer_id).first();
  const first = (c.name || "").split(" ")[0] || "there", site = env.SITE_URL, acct = site + "/#account", label = planLabel(m.type, m.freq, m.size);
  const T = {
    receipt: () => ["Apex Membership receipt · " + money(o.amount + (o.tax || 0)), `<h1 style="font-size:22px;margin:0 0 8px">Thanks, ${h(first)}!</h1><p style="margin:0;color:#444">Your Apex Membership is paid for this month. Pick your visit times in your account.</p>` +
      rows([["Plan", label], ["Period", niceDay(o.period[0]) + " – " + niceDay(addDays(o.period[1], -1))], ["Visits", m.freq + (o.cover !== m.type ? " (" + MEM.plans[o.cover].name + " visits for winter)" : "")], ["Membership", money(o.amount) + (o.credit ? " (" + money(o.credit) + " credit used)" : "")], [TAX_LABEL, money(o.tax || 0)], ["Charged", money(o.amount + (o.tax || 0))], ["Card", o.card ? o.card.brand + " ending " + o.card.last4 : ""], ["Last month", o.last ? "Your membership ends " + niceDay(o.last) : ""]]) +
      (o.receipt ? `<p style="margin:0 0 14px"><a href="${h(o.receipt)}" style="color:#111">View the Square receipt</a></p>` : "") + `<p style="margin:0">${button(acct, "Pick my visit times")}</p>`],
    fail: () => ["Action needed: your Apex Membership payment didn't go through", `<h1 style="font-size:22px;margin:0 0 8px">Your payment didn't go through</h1><p style="margin:0;color:#444;line-height:1.55">We couldn't charge ${money(o.amount)} for your Apex Membership. Please update your card in your account. We'll try again on ${niceDay(o.retry || "")}. Visits are paused until it's paid.</p><p style="margin:18px 0 0">${button(acct, "Update my card")}</p>`],
    fail_final: () => ["Your Apex Membership was cancelled", `<h1 style="font-size:22px;margin:0 0 8px">Your membership was cancelled</h1><p style="margin:0;color:#444;line-height:1.55">We tried several times but couldn't charge ${money(o.amount)} for your Apex Membership, so it's been cancelled. That amount is still owed. Reply to this email or text (732) 206-7084 and we'll sort it out.</p>`],
    card_needed: () => ["Add a card to start your Apex Membership", `<h1 style="font-size:22px;margin:0 0 8px">One step left, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">Your ${h(label)} membership needs a card on file. Please add one in your account by ${niceDay(o.deadline)}, or the membership won't start. Your first charge is one month after your detail.</p><p style="margin:18px 0 0">${button(acct, "Add my card")}</p>`],
    nocard_cancel: () => ["Your Apex Membership didn't start", `<h1 style="font-size:22px;margin:0 0 8px">Your membership didn't start</h1><p style="margin:0;color:#444;line-height:1.55">We didn't get a card within 14 days of your detail, so your Apex Membership wasn't started and you won't be charged. You can start one after your next qualifying detail.</p>`],
    cancelled: () => ["Your Apex Membership is cancelled", `<h1 style="font-size:22px;margin:0 0 8px">You're cancelled</h1><p style="margin:0;color:#444;line-height:1.55">No more monthly charges. Your membership stays active through ${niceDay(o.ends)}, so keep using any visits you've booked. We'd love to have you back anytime.</p>`],
    finishing: () => ["Your Apex Membership will end after your 3rd month", `<h1 style="font-size:22px;margin:0 0 8px">Got it, ${h(first)}</h1><p style="margin:0;color:#444;line-height:1.55">You'll keep your visits and the remaining ${o.left} monthly payment(s) in your first 3 months will go through as usual. Your membership ends automatically after that. No fee.</p>`],
    cancel_fee: () => ["Your Apex Membership is cancelled", `<h1 style="font-size:22px;margin:0 0 8px">You're cancelled</h1><p style="margin:0;color:#444;line-height:1.55">We charged the ${money(o.fee)} early cancellation fee plus ${money(o.tax || 0)} ${h(TAX.name)} (${money(o.fee + (o.tax || 0))} total) to your ${h((o.card || {}).brand || "card")} ending ${h((o.card || {}).last4 || "")}. No more monthly charges.${o.ends > todayNY().key ? " You can still use visits you've already paid for through " + niceDay(o.ends) + "." : ""}</p>`]
  }[kind];
  if (!T) return;
  let R; try { R = T(); } catch (e) { console.log("membership email failed", kind, e.message); return; }
  return send(env, { to: c.email, subject: R[0], html: layout(R[0], R[1], R[0], site + "/email-logo.png") }).catch(() => {});
}
