// Owner dashboard v2 API (Nov 2): customers + vehicles, jobs (add, edit, reschedule, cancel, status, get paid, delete),
// photos, Apex Membership actions, Square fees/payouts + yearly totals, editable settings, data backup.
// Called from adminApi (admin.js) after the Cloudflare Access check. Returns null for paths it doesn't handle.
import { RULES, jobMin, nyToUtc, utcToNy, addDays, parseDay, townCoords, milesFromHome, inWinter } from "./sched.js";
import { PRICING, TAX, quote as priceQuote, withTax } from "./pricing.js";
import { MEM, planLabel, planPrice, activeFor, cancelMembership, retryNow, cancelWithDetail, moveWithDetail, summary as memSummary, coverOn, cancelWaived, pauseByOwner, resumeByOwner, changePlan } from "./membership.js";
import { deleteJob } from "./cal.js";
import { normEmail, newId } from "./accounts.js";
import { squareOn, listPayments, listPayouts } from "./square.js";
import { currentSettings, saveSettings, resetSettings } from "./settings.js";
import { jobAction } from "./pay.js";
import { photoState, setAngle, addAngle, photoFile, hidePhoto, deletePhoto, deleteJobPhotos, sendPhotosEmail, storageOn } from "./photos.js";

const json = (data, status) => new Response(JSON.stringify(data), { status: status || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const bad = (msg, status) => json({ error: msg }, status || 400);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDay = k => { if (!DAY_RE.test(String(k || ""))) return false; const { y, m, d } = parseDay(k), t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const todayKey = () => utcToNy(Date.now()).key;
const cl = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n || 200);
const NOEMAIL = /\.invalid$/i;
export const realEmail = e => (e && !NOEMAIL.test(e) ? e : null);
const usd = c => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);

export async function ownerLog(env, who, what, ref, detail) {
  await env.DB.prepare("INSERT INTO owner_log (at, who, what, ref, detail) VALUES (?, ?, ?, ?, ?)").bind(Date.now(), who || null, String(what).slice(0, 200), ref || null, detail ? String(detail).slice(0, 500) : null).run().catch(() => {});
}
async function logFor(env, ref) { return ((await env.DB.prepare("SELECT at, what, detail FROM owner_log WHERE ref = ? ORDER BY at DESC LIMIT 30").bind(ref).all()).results || []); }

// ---------- jobs: status + list rows ----------
// Scheduled → In progress → Done → Paid (member visits: Done = covered by the membership)
export function statusOf(b) {
  if (b.status === "cancelled") return "cancelled";
  if (b.kind === "member") return b.completed_at ? "done" : b.started_at ? "in_progress" : "scheduled";
  if (b.paid_at && b.completed_at) return "paid";
  if (b.paid_at) return b.started_at ? "in_progress" : "scheduled";   // paid ahead (prepaid): still to do
  if (b.completed_at) return "done";
  if (b.started_at) return "in_progress";
  return "scheduled";
}
export function jobRow(b, H, full) {
  const r = { id: b.id, kind: b.kind || "detail", what: H.pkgName(b), pkg: b.pkg, size: b.size, start_utc: b.start_utc, end_utc: b.end_utc, day: b.day, name: b.name, town: b.town,
    car: [b.car, b.color].filter(Boolean).join(" · "), acked: !!b.acked_at, paid: !!b.paid_at, done: !!b.completed_at, started: !!b.started_at, state: statusOf(b), status: b.status,
    custom: !!b.custom_name, owner: b.source === "owner", job: b.ack_token ? "/job/" + b.ack_token : null, customer_id: b.customer_id || null, cancelReason: b.cancel_reason || null };
  if (b.quote != null) r.quote = b.quote;
  if (full) Object.assign(r, { phone: b.phone, email: realEmail(b.email), address: b.address, final: b.final_cents != null ? b.final_cents / 100 : null, tax: b.tax_cents ? b.tax_cents / 100 : 0, tip: b.tip_cents ? b.tip_cents / 100 : 0,
    method: b.paid_method, adds: JSON.parse(b.adds || "[]"), notes: b.notes, water: b.water, power: b.power, manage: b.token ? "/b/" + b.token : null });
  return r;
}
// a thumbnail (newest After, else Before) + photo counts for each job in a list
export async function withThumbs(env, rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id).slice(0, 90);
  const ph = (await env.DB.prepare("SELECT id, booking_id, phase FROM photos WHERE deleted_at IS NULL AND replaced_at IS NULL AND booking_id IN (" + ids.map(() => "?").join(",") + ") ORDER BY taken_at").bind(...ids).all()).results || [];
  const by = {};
  for (const p of ph) { const x = by[p.booking_id] || (by[p.booking_id] = { n: 0, after: null, before: null }); x.n++; x[p.phase] = p.id; }
  for (const r of rows) { const x = by[r.id]; r.photos = x ? x.n : 0; r.thumb = x ? x.after || x.before : null; }
  return rows;
}

// ---------- customers + vehicles ----------
const initials = n => String(n || "?").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
export function parseCar(name) {
  const s = String(name || "").trim().replace(/\s+/g, " "), m = s.match(/^((?:19|20)\d{2})\s+(\S+)\s*(.*)$/);
  if (m) return { year: m[1], make: m[2], model: m[3] || "" };
  const w = s.split(" "); return { year: "", make: w[0] || "", model: w.slice(1).join(" ") };
}
export const vname = v => [v.year, v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
const vkey = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const vOut = v => ({ id: v.id, year: v.year || "", make: v.make || "", model: v.model || "", color: v.color || "", plate: v.plate || "", size: v.size, notes: v.notes || "", name: vname(v) });

// Customers who booked online have cars as text ("2021 Toyota RAV4"). Turn each into a vehicle record once and link the bookings.
async function syncVehicles(env, cid) {
  const q = (sqlAll, sqlOne) => (cid ? env.DB.prepare(sqlOne).bind(cid) : env.DB.prepare(sqlAll)).all().then(r => r.results || []);
  const cs = await q("SELECT id, cars FROM customers", "SELECT id, cars FROM customers WHERE id = ?");
  if (!cs.length) return;
  const vs = await q("SELECT * FROM vehicles", "SELECT * FROM vehicles WHERE customer_id = ?");
  const bs = await q("SELECT id, customer_id, car, color, size, vehicle_id, start_utc FROM bookings WHERE customer_id IS NOT NULL AND car IS NOT NULL AND car != ''",
    "SELECT id, customer_id, car, color, size, vehicle_id, start_utc FROM bookings WHERE customer_id = ? AND car IS NOT NULL AND car != ''");
  const map = {};
  for (const v of vs) { map[v.customer_id + "|" + vkey(vname(v))] = v; if (v.src) map[v.customer_id + "|" + v.src] = v; }
  const stmts = [], now = Date.now();
  const want = (custId, name, color, size) => {
    const kk = vkey(name), k = custId + "|" + kk; if (!kk) return null; if (map[k]) return map[k];
    const p = parseCar(name), v = { id: newId(), customer_id: custId, year: p.year, make: p.make, model: p.model, color: cl(color, 30) || null, size: [0, 1, 2].includes(+size) ? +size : null, src: kk };
    map[k] = v;
    stmts.push(env.DB.prepare("INSERT INTO vehicles (id, customer_id, year, make, model, color, size, src, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(v.id, custId, v.year, v.make, v.model, v.color, v.size, kk, now, now));
    return v;
  };
  for (const b of bs.sort((a, c) => a.start_utc - c.start_utc)) { if (b.vehicle_id) continue; const v = want(b.customer_id, b.car, b.color, b.size); if (v) stmts.push(env.DB.prepare("UPDATE bookings SET vehicle_id = ? WHERE id = ? AND vehicle_id IS NULL").bind(v.id, b.id)); }
  for (const c of cs) for (const car of JSON.parse(c.cars || "[]")) want(c.id, car.name, car.color, car.size);
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

function readCustomer(body, partial) {
  const f = {};
  const has = k => !partial || Object.hasOwn(body, k);
  if (has("name")) { f.name = cl(body.name, 80); if (f.name.length < 1) throw new Error("Enter a name."); }
  if (has("phone")) { f.phone = cl(body.phone, 30); if (f.phone && f.phone.replace(/\D/g, "").length < 10) throw new Error("That phone number looks short."); }
  if (has("email")) { f.email = normEmail(cl(body.email, 120)); if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) throw new Error("That email doesn't look right."); }
  if (has("address")) f.address = cl(body.address, 160);
  if (has("town")) f.town = cl(body.town, 60);
  if (has("owner_notes")) f.owner_notes = cl(body.owner_notes, 2000);
  return f;
}
function readVehicle(body) {
  const f = { year: cl(body.year, 4).replace(/\D/g, ""), make: cl(body.make, 30), model: cl(body.model, 40), color: cl(body.color, 30), plate: cl(body.plate, 12).toUpperCase(), notes: cl(body.notes, 500),
    size: [0, 1, 2].includes(+body.size) && body.size !== "" && body.size != null ? +body.size : null };
  if (f.year && (+f.year < 1950 || +f.year > new Date().getUTCFullYear() + 2)) throw new Error("Check the year.");
  if (!f.make && !f.model) throw new Error("Enter at least the make or model.");
  return f;
}

async function customerList(env, url) {
  await syncVehicles(env);
  const arch = url.searchParams.get("archived") === "1";
  const r = (await env.DB.prepare(`SELECT c.id, c.name, c.email, c.phone, c.town, c.card, c.created_at, c.archived_at, c.owner_notes,
      (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.kind != 'member') details,
      (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed' AND b.kind = 'member') visits,
      (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id AND b.cancel_reason = 'noshow') noshows,
      (SELECT MAX(day) FROM bookings b WHERE b.customer_id = c.id AND b.status = 'confirmed') last_day,
      (SELECT COALESCE(SUM(final_cents + COALESCE(tax_cents,0) + COALESCE(tip_cents,0)),0) FROM bookings b WHERE b.customer_id = c.id AND b.paid_at IS NOT NULL AND b.kind != 'member') paid,
      (SELECT status FROM memberships m WHERE m.customer_id = c.id AND m.status != 'cancelled' ORDER BY created_at DESC LIMIT 1) member
    FROM customers c WHERE c.archived_at IS ${arch ? "NOT " : ""}NULL ORDER BY LOWER(COALESCE(NULLIF(c.name, ''), c.email)) LIMIT 1000`).all()).results || [];
  const vs = (await env.DB.prepare("SELECT * FROM vehicles WHERE deleted_at IS NULL ORDER BY created_at").all()).results || [], byC = {};
  for (const v of vs) (byC[v.customer_id] || (byC[v.customer_id] = [])).push(v);
  const archivedCount = arch ? 0 : (await env.DB.prepare("SELECT COUNT(*) n FROM customers WHERE archived_at IS NOT NULL").first()).n;
  return json({ archivedCount, customers: r.map(c => { const card = c.card ? JSON.parse(c.card) : null, v = byC[c.id] || [];
    return { id: c.id, name: c.name || "", initials: initials(c.name || c.email), email: realEmail(c.email), phone: c.phone, town: c.town, vehicle: v[0] ? vname(v[0]) : null, vehicles: v.length, plates: v.map(x => x.plate).filter(Boolean),
      card: card ? card.brand + " ending " + card.last4 : null, details: c.details, visits: c.visits, noshows: c.noshows, lastDay: c.last_day, paid: c.paid / 100, member: c.member, since: c.created_at, archived: !!c.archived_at, notes: !!c.owner_notes }; }) });
}

async function customerDetail(env, H, id) {
  await syncVehicles(env, id);
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
  if (!c) return bad("That customer doesn't exist anymore.", 404);
  const vs = (await env.DB.prepare("SELECT * FROM vehicles WHERE customer_id = ? AND deleted_at IS NULL ORDER BY created_at").bind(id).all()).results || [];
  const bs = (await env.DB.prepare("SELECT * FROM bookings WHERE customer_id = ? OR (customer_id IS NULL AND email = ?) ORDER BY start_utc DESC LIMIT 200").bind(id, c.email).all()).results || [];
  const jobs = await withThumbs(env, bs.map(b => Object.assign(jobRow(b, H), { vehicle_id: b.vehicle_id, total: b.paid_at && b.kind !== "member" ? (b.final_cents + (b.tax_cents || 0) + (b.tip_cents || 0)) / 100 : null })));
  const m = (await env.DB.prepare("SELECT * FROM memberships WHERE customer_id = ? ORDER BY created_at DESC LIMIT 1").bind(id).first());
  const card = c.card ? JSON.parse(c.card) : null;
  return json({ customer: { id: c.id, name: c.name || "", initials: initials(c.name || c.email), email: realEmail(c.email), phone: c.phone || "", address: c.address || "", town: c.town || "", owner_notes: c.owner_notes || "",
      their_notes: c.notes || "", card: card ? card.brand + " ending " + card.last4 : null, sms_ok: !!c.sms_ok, since: c.created_at, archived: !!c.archived_at, account: !NOEMAIL.test(c.email || "") },
    vehicles: vs.map(vOut), jobs, noshows: bs.filter(b => b.cancel_reason === "noshow").length,
    membership: m ? Object.assign(await memSummary(env, m, c), { id: m.id, cancelled: m.status === "cancelled" }) : null, log: await logFor(env, "c:" + id) });
}

// ---------- jobs: open times for Nick (no 24-hour notice; he can also pick "any time") ----------
function openTimes(day, info, len) {
  const now = utcToNy(Date.now()), max = info.off ? RULES.maxJobsDayOff : RULES.maxJobs, out = [];
  if (day < now.key) return { times: [], reason: "past" };
  if (info.j >= max) return { times: [], reason: "full" };
  for (let t = RULES.startMin; t + len <= info.end; t += RULES.stepMin) {
    if (day === now.key && t <= now.min) continue;
    if (info.b.every(b => t + len <= b[0] || t >= b[1])) out.push(t);
  }
  return { times: out, reason: out.length ? null : "busy" };
}
const fitsAt = (day, info, start, len) => openTimes(day, info, len).times.includes(start);
const winterDay = k => { const { y, m, d } = parseDay(k); return inWinter(y, m, d); };

async function priceFor(env, c, pkg, size, adds, town, except) {
  const pin = c && c.lat != null && c.lon != null ? [c.lat, c.lon] : townCoords(town || (c && c.town));
  const miles = pin ? Math.round(milesFromHome(pin[0], pin[1]) * 10) / 10 : null;
  // returning customer = an earlier detail (not the one being edited, and not ones booked after it)
  const prior = c ? (await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE (customer_id = ? OR email = ?) AND status != 'cancelled' AND kind != 'member' AND id != ? AND created_at < ?").bind(c.id, c.email, except ? except.id : "", except ? except.created_at : Date.now() + 1).first()).n : 0;
  const member = c ? !!(await activeFor(env, c.id)) : false;
  const q = priceQuote({ pkg, size, adds, miles, returning: prior > 0, member });
  return Object.assign(q, { miles, member, returning: prior > 0, tooFar: miles != null && miles > RULES.maxMiles });
}

function readJob(body) {
  const custom = body.pkg === "custom";
  const f = { pkg: custom ? "full" : String(body.pkg || ""), customName: custom ? cl(body.customName, 40) : null, size: +body.size, adds: Array.isArray(body.adds) ? body.adds.map(x => cl(x, 20)) : [],
    day: cl(body.day, 10), start: Math.round(+body.start), duration: body.durationMin != null && body.durationMin !== "" ? Math.round(+body.durationMin) : null,
    price: body.price != null && body.price !== "" ? Math.round(+body.price) : null, notes: cl(body.notes, 1500), ownerNotes: cl(body.ownerNotes, 2000),
    address: cl(body.address, 160), town: cl(body.town, 60), water: cl(body.water, 5), power: cl(body.power, 5), anyTime: body.anyTime === true, notify: body.notify !== false };
  if (!["exterior", "interior", "full"].includes(f.pkg)) throw new Error("Pick a package.");
  if (custom && !f.customName) throw new Error("Give the custom package a name.");
  if (![0, 1, 2].includes(f.size)) throw new Error("Pick Sedan, SUV or Truck.");
  f.adds = custom ? [] : [...new Set(f.adds)].filter(a => Object.hasOwn(RULES.addonPkgs, a) && RULES.addonPkgs[a].includes(f.pkg));
  if (!realDay(f.day)) throw new Error("Pick a date.");
  if (!(f.start >= 0 && f.start < 1440)) throw new Error("Pick a start time.");
  if (custom && f.duration == null) throw new Error("How long will it take?");
  if (f.duration != null && !(f.duration >= 15 && f.duration <= 720)) throw new Error("Length must be between 15 minutes and 12 hours.");
  if (f.price != null && !(f.price >= 0 && f.price <= 5000)) throw new Error("Enter a price between $0 and $5,000 (before tax).");
  return f;
}

async function createJob(env, H, body, who) {
  let f; try { f = readJob(body); } catch (e) { return bad(e.message); }
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(String(body.customerId || "")).first();
  if (!c) return bad("Pick a customer.");
  let v = body.vehicleId ? await env.DB.prepare("SELECT * FROM vehicles WHERE id = ? AND customer_id = ?").bind(String(body.vehicleId), c.id).first() : null;
  if (!v && body.newVehicle) {
    let nv; try { nv = readVehicle(body.newVehicle); } catch (e) { return bad(e.message); }
    v = Object.assign({ id: newId(), customer_id: c.id }, nv); const now = Date.now();
    await env.DB.prepare("INSERT INTO vehicles (id, customer_id, year, make, model, color, plate, size, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(v.id, c.id, v.year, v.make, v.model, v.color, v.plate, v.size, v.notes, now, now).run();
  }
  const len = f.duration || jobMin(f.pkg, f.size, f.adds);
  const info = (await H.days(env, f.day, 1))[f.day];
  if (!f.anyTime && !fitsAt(f.day, info, f.start, len)) return bad("That time isn't open (your calendar, blocked time or another job). Pick an open time, or turn on \"Any time\".", 409);
  const address = f.address || c.address || "", town = f.town || c.town || "";
  const q = f.customName ? null : await priceFor(env, c, f.pkg, f.size, f.adds, town);
  const quote = f.price != null ? f.price : q ? q.subtotal : 0;
  const card = body.pay === "card" && c.card ? (x => JSON.stringify({ id: x.id, brand: x.brand, last4: x.last4 }))(JSON.parse(c.card)) : null;
  const start_utc = nyToUtc(f.day, f.start), now = Date.now();
  const b = { id: H.code(6), token: H.secret(), ack_token: H.secret(), status: "confirmed", created_at: now, start_utc, end_utc: start_utc + len * 60000, day: f.day, pkg: f.pkg, size: f.size, adds: JSON.stringify(f.adds),
    quote, travel_fee: q && f.price == null ? q.travel : 0, miles: q ? q.miles : null, name: c.name || "Customer", phone: c.phone || "", email: c.email, address, town, car: v ? vname(v) : "", color: v ? v.color || "" : "",
    water: f.water || null, power: f.power || null, notes: f.notes || null, card_on_file: card ? 1 : 0, remind: c.remind == null ? 1 : c.remind, customer_id: c.id, card, vehicle_id: v ? v.id : null,
    custom_name: f.customName, owner_notes: f.ownerNotes || null, source: "owner", kind: "detail", acked_at: now };
  await env.DB.prepare(`INSERT INTO bookings (id, token, ack_token, status, created_at, start_utc, end_utc, day, pkg, size, adds, quote, travel_fee, miles, name, phone, email, address, town, car, color, water, power, notes,
      card_on_file, remind, customer_id, card, vehicle_id, custom_name, owner_notes, source, kind, acked_at) VALUES (${Array(34).fill("?").join(", ")})`)
    .bind(b.id, b.token, b.ack_token, b.status, b.created_at, b.start_utc, b.end_utc, b.day, b.pkg, b.size, b.adds, b.quote, b.travel_fee, b.miles, b.name, b.phone, b.email, b.address, b.town, b.car, b.color, b.water, b.power, b.notes,
      b.card_on_file, b.remind, b.customer_id, b.card, b.vehicle_id, b.custom_name, b.owner_notes, b.source, b.kind, b.acked_at).run();
  const tasks = [H.calSave(env, b).catch(e => console.log("calendar save failed", e.message))];
  if (f.notify && realEmail(b.email)) tasks.push(H.emailCustomer(env, b, "new").catch(e => console.log("customer email failed", e.message)));
  await Promise.all(tasks);
  await ownerLog(env, who, "Added a job " + b.id + " (" + H.pkgName(b) + ")", "c:" + c.id);
  await ownerLog(env, who, "Job added from the dashboard" + (f.anyTime ? " (any time)" : "") + (f.notify && realEmail(b.email) ? ", customer emailed" : ""), "j:" + b.id);
  return json({ ok: true, id: b.id });
}

async function jobDetail(env, H, b) {
  const c = b.customer_id ? await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(b.customer_id).first() : null;
  const v = b.vehicle_id ? await env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(b.vehicle_id).first() : null;
  const card = b.card ? JSON.parse(b.card) : null, est = withTax((b.quote || 0) * 100);
  const m = b.kind === "member" && b.membership_id ? await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(b.membership_id).first() : null;
  const startsMem = b.kind !== "member" ? await env.DB.prepare("SELECT id, type, freq, size, status FROM memberships WHERE qualifying_booking = ? AND status != 'cancelled'").bind(b.id).first() : null;
  const r = Object.assign(jobRow(b, H, true), {
    customName: b.custom_name || null, ownerNotes: b.owner_notes || "", heard: b.heard || "", miles: b.miles, travel: b.travel_fee || 0, history: JSON.parse(b.history || "[]"),
    estimate: { sub: est.sub / 100, tax: est.tax / 100, total: est.total / 100 }, card: card ? card.brand + " ending " + card.last4 : null, squareOn: squareOn(env),
    customer: c ? { id: c.id, name: c.name, email: realEmail(c.email), phone: c.phone, card: c.card ? (x => x.brand + " ending " + x.last4)(JSON.parse(c.card)) : null, notes: c.owner_notes || "" } : null,
    vehicle: v ? vOut(v) : null, membership: m ? { id: m.id, label: planLabel(m.type, m.freq, m.size), status: m.status } : null,
    startsMembership: startsMem ? { id: startsMem.id, label: planLabel(startsMem.type, startsMem.freq, startsMem.size) } : null,
    payLink: b.pay_token && !b.paid_at ? env.SITE_URL + "/pay/" + b.pay_token : null, manageLink: env.SITE_URL + "/b/" + b.token, galleryLink: env.SITE_URL + "/b/" + b.token + "/photos",
    paidAt: b.paid_at, completedAt: b.completed_at, startedAt: b.started_at, cancelledAt: b.cancelled_at, receipt: b.receipt_url || null, termsAt: b.terms_at || null,
    canDelete: !b.paid_at && b.kind !== "member" && (b.status === "cancelled" || b.source === "owner") && !startsMem,
    photos: await photoState(env, b), log: await logFor(env, "j:" + b.id) });
  return json({ job: r });
}

async function editJob(env, H, b, body, who) {
  const f = {};
  if (Object.hasOwn(body, "ownerNotes")) f.owner_notes = cl(body.ownerNotes, 2000) || null;
  const changing = ["pkg", "size", "adds", "price", "customName", "durationMin", "notes", "address", "town", "water", "power", "vehicleId"].some(k => Object.hasOwn(body, k));
  if (changing) {
    if (b.status !== "confirmed" || b.paid_at) return bad("This job is " + (b.paid_at ? "paid" : "cancelled") + ", so only your notes can change.");
    if (Object.hasOwn(body, "notes")) f.notes = cl(body.notes, 1500) || null;
    if (Object.hasOwn(body, "address")) f.address = cl(body.address, 160);
    if (Object.hasOwn(body, "town")) f.town = cl(body.town, 60);
    if (Object.hasOwn(body, "water")) f.water = cl(body.water, 5) || null;
    if (Object.hasOwn(body, "power")) f.power = cl(body.power, 5) || null;
    if (Object.hasOwn(body, "vehicleId")) {
      const v = body.vehicleId ? await env.DB.prepare("SELECT * FROM vehicles WHERE id = ? AND customer_id = ?").bind(String(body.vehicleId), b.customer_id || "").first() : null;
      if (body.vehicleId && !v) return bad("Pick one of this customer's vehicles.");
      f.vehicle_id = v ? v.id : null; f.car = v ? vname(v) : b.car; f.color = v ? v.color || "" : b.color;
    }
    if (b.kind !== "member" && ["pkg", "size", "adds", "customName", "durationMin", "price"].some(k => Object.hasOwn(body, k))) {
      const pkg = body.pkg === "custom" ? "full" : Object.hasOwn(body, "pkg") ? String(body.pkg) : b.pkg;
      if (!["exterior", "interior", "full"].includes(pkg)) return bad("Pick a package.");
      const custom = body.pkg === "custom" || (!Object.hasOwn(body, "pkg") && b.custom_name);
      const customName = custom ? cl(Object.hasOwn(body, "customName") ? body.customName : b.custom_name, 40) : null;
      if (custom && !customName) return bad("Give the custom package a name.");
      const size = Object.hasOwn(body, "size") ? +body.size : b.size; if (![0, 1, 2].includes(size)) return bad("Pick Sedan, SUV or Truck.");
      const adds = custom ? [] : (Object.hasOwn(body, "adds") && Array.isArray(body.adds) ? body.adds : JSON.parse(b.adds || "[]")).filter(a => Object.hasOwn(RULES.addonPkgs, a) && RULES.addonPkgs[a].includes(pkg));
      const dur = body.durationMin != null && body.durationMin !== "" ? Math.round(+body.durationMin) : null;
      if (dur != null && !(dur >= 15 && dur <= 720)) return bad("Length must be between 15 minutes and 12 hours.");
      const len = dur || (custom ? Math.round((b.end_utc - b.start_utc) / 60000) : jobMin(pkg, size, adds));
      Object.assign(f, { pkg, size, adds: JSON.stringify(adds), custom_name: customName, end_utc: b.start_utc + len * 60000 });
      if (body.price != null && body.price !== "") { const p = Math.round(+body.price); if (!(p >= 0 && p <= 5000)) return bad("Enter a price between $0 and $5,000 (before tax)."); f.quote = p; f.travel_fee = 0; }
      else if (!custom && ["pkg", "size", "adds"].some(k => Object.hasOwn(body, k))) {
        const c = b.customer_id ? await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(b.customer_id).first() : null;
        const q = await priceFor(env, c, pkg, size, adds, f.town || b.town, b); f.quote = q.subtotal; f.travel_fee = q.travel;
      }
    }
  }
  const k = Object.keys(f); if (!k.length) return json({ ok: true });
  await env.DB.prepare("UPDATE bookings SET " + k.map(x => x + " = ?").join(", ") + " WHERE id = ?").bind(...k.map(x => f[x]), b.id).run();
  Object.assign(b, f);
  if (changing && b.status === "confirmed") await H.calSave(env, b).catch(() => {});
  if (changing) await ownerLog(env, who, "Edited the job details", "j:" + b.id, k.filter(x => x !== "owner_notes").join(", "));
  return json({ ok: true });
}

async function moveJob(env, H, b, body, who) {
  if (b.status !== "confirmed" || b.completed_at) return bad("Only jobs that aren't done yet can be moved.");
  const day = cl(body.day, 10), start = Math.round(+body.start);
  if (!realDay(day) || !(start >= 0 && start < 1440)) return bad("Pick a new date and time.");
  let pkg = b.pkg, len = Math.round((b.end_utc - b.start_utc) / 60000);
  if (b.kind === "member") {
    const mm = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(b.membership_id).first(), cv = mm && coverOn(mm.type, day);
    if (!cv) return bad("That membership has no visits on that date (winter pause).");
    if (MEM.visitPkg[cv] !== pkg) { pkg = MEM.visitPkg[cv]; len = jobMin(pkg, b.size, ["_member"]); }
  }
  const info = (await H.days(env, day, 1, b.id))[day];
  if (body.anyTime !== true && !fitsAt(day, info, start, len)) return bad("That time isn't open. Pick an open time, or turn on \"Any time\".", 409);
  const was = H.whenText(b), start_utc = nyToUtc(day, start), hist = JSON.parse(b.history || "[]"); hist.push({ at: Date.now(), from: b.start_utc, by: "owner" });
  await env.DB.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, day = ?, pkg = ?, history = ?, reminded_at = NULL WHERE id = ?").bind(start_utc, start_utc + len * 60000, day, pkg, JSON.stringify(hist), b.id).run();
  Object.assign(b, { start_utc, end_utc: start_utc + len * 60000, day, pkg });
  if (b.kind !== "member") b._mem = await moveWithDetail(env, b).catch(e => { console.log("membership move failed", e.message); return null; });
  const tasks = [H.calSave(env, b).catch(() => {})];
  if (body.notify !== false && realEmail(b.email)) tasks.push(H.emailCustomer(env, b, "move").catch(() => {}));
  await Promise.all(tasks);
  await ownerLog(env, who, "Moved from " + was + " to " + H.whenText(b) + (body.notify !== false && realEmail(b.email) ? " (customer emailed)" : ""), "j:" + b.id);
  return json({ ok: true, when: H.whenText(b) });
}

async function cancelJob(env, H, b, body, who) {
  if (b.status !== "confirmed") return bad("It's already cancelled.");
  if (b.kind === "member" && b.completed_at) return bad("This visit is already done.");
  if (body.reason === "refunded") {   // the money went back in Square: take it out of sales tax and income (records are kept)
    if (!b.paid_at || b.kind === "member") return bad("Only a paid job can be marked refunded.");
    await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'refunded' WHERE id = ?").bind(Date.now(), b.id).run();
    if (b.end_utc > Date.now()) await deleteJob(env, b.cal_href).catch(() => {});
    await ownerLog(env, who, "Marked refunded (" + usd((b.final_cents || 0) + (b.tax_cents || 0) + (b.tip_cents || 0)) + " refunded in Square); left out of sales tax and income", "j:" + b.id);
    return json({ ok: true, credit: 0 });
  }
  if (b.paid_at && b.kind !== "member") return bad("This job is paid. Refund it in Square first, then choose \"Refunded in Square\".");
  const reason = ["customer", "us", "noshow"].includes(body.reason) ? body.reason : null; if (!reason) return bad("Pick why it's cancelled.");
  const notify = body.notify !== false && !!realEmail(b.email), hoursLeft = (b.start_utc - Date.now()) / 3600e3;
  await env.DB.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ?").bind(Date.now(), reason, b.id).run();
  b.status = "cancelled";
  let credit = 0, memC = null;
  if (b.kind === "member") credit = await H.creditVisit(env, b, reason === "us" ? 1 : reason === "customer" && hoursLeft >= MEM.skipNoticeHours ? MEM.skipCreditRate : 0);
  else memC = await cancelWithDetail(env, b, reason === "us").catch(e => { console.log("membership cancel failed", e.message); return null; });
  const tasks = [deleteJob(env, b.cal_href).catch(() => {})];
  if (notify) {
    if (reason === "us") tasks.push(H.emailCancelByUs(env, b, credit).catch(() => {}));
    else if (reason === "customer") tasks.push(b.kind === "member" ? H.emailSkip(env, b, credit).catch(() => {}) : H.emailCustomer(env, b, "cancel").catch(() => {}));
  }
  await Promise.all(tasks);
  const why = { customer: "the customer asked", us: "weather or our side", noshow: "no-show" }[reason];   // refunds are handled above
  await ownerLog(env, who, "Cancelled (" + why + ")" + (credit ? ", " + usd(credit) + " membership credit" : "") + (memC ? ", its membership was cancelled too" : "") + (notify && reason !== "noshow" ? ", customer emailed" : ""), "j:" + b.id);
  return json({ ok: true, credit: credit / 100, membershipCancelled: !!memC });
}

async function setStatus(env, b, to, who) {
  if (b.status !== "confirmed") return bad("This job is cancelled.");
  const now = Date.now();
  if (to === "in_progress") { if (b.completed_at) return bad("It's already done."); await env.DB.prepare("UPDATE bookings SET started_at = COALESCE(started_at, ?) WHERE id = ?").bind(now, b.id).run(); }
  else if (to === "scheduled") { if (b.completed_at) return bad("It's already done."); await env.DB.prepare("UPDATE bookings SET started_at = NULL WHERE id = ?").bind(b.id).run(); }
  else if (to === "done") {
    if (b.kind === "member") await env.DB.prepare("UPDATE bookings SET completed_at = COALESCE(completed_at, ?), started_at = COALESCE(started_at, ?), paid_at = COALESCE(paid_at, ?), paid_method = 'membership', final_cents = 0 WHERE id = ?").bind(now, now, now, b.id).run();
    else await env.DB.prepare("UPDATE bookings SET completed_at = COALESCE(completed_at, ?), started_at = COALESCE(started_at, ?) WHERE id = ?").bind(now, now, b.id).run();
  } else if (to === "not_done") {
    if (b.paid_at && b.kind !== "member") return bad("It's paid, so it stays done.");
    await env.DB.prepare("UPDATE bookings SET completed_at = NULL" + (b.kind === "member" ? ", paid_at = NULL, paid_method = NULL, final_cents = NULL" : "") + " WHERE id = ?").bind(b.id).run();
  } else return bad("Unknown status.");
  await ownerLog(env, who, { in_progress: "Started the job", scheduled: "Moved back to scheduled", done: "Marked done", not_done: "Marked not done" }[to], "j:" + b.id);
  return json({ ok: true });
}

async function deleteJobRow(env, b, who) {
  if (b.paid_at) return bad("Paid jobs stay in your records (sales tax and income). Cancel it instead.");
  if (b.kind === "member") return bad("Member visits stay on their membership record. Cancel it instead.");
  if (b.status === "confirmed" && b.source !== "owner") return bad("This was booked online. Cancel it first so the customer is told.");
  const m = await env.DB.prepare("SELECT id FROM memberships WHERE qualifying_booking = ? AND status != 'cancelled'").bind(b.id).first();
  if (m) return bad("An Apex Membership started from this job. Cancel the job instead.");
  if (b.status === "confirmed") await deleteJob(env, b.cal_href).catch(() => {});
  await deleteJobPhotos(env, b.id);
  await env.DB.prepare("DELETE FROM bookings WHERE id = ?").bind(b.id).run();
  if (b.customer_id) await ownerLog(env, who, "Deleted job " + b.id + " (" + b.day + ")", "c:" + b.customer_id);
  return json({ ok: true });
}

// ---------- Apex Membership ----------
async function memberDetail(env, id) {
  const m = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(id).first(); if (!m) return bad("Not found", 404);
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(m.customer_id).first();
  const ch = (await env.DB.prepare("SELECT kind, amount_cents, tax_cents, credit_used_cents, status, error, for_day, created_at FROM membership_charges WHERE membership_id = ? ORDER BY created_at DESC LIMIT 40").bind(id).all()).results || [];
  const visits = (await env.DB.prepare("SELECT id, day, start_utc, end_utc, pkg, status, completed_at, cancel_reason, credit_cents FROM bookings WHERE membership_id = ? ORDER BY start_utc DESC LIMIT 40").bind(id).all()).results || [];
  const s = await memSummary(env, m, c);
  return json({ member: Object.assign(s, { id: m.id, customer: { id: c.id, name: c.name, email: realEmail(c.email), phone: c.phone }, cancelledAt: m.status === "cancelled" ? m.updated_at : null,
      minPayments: MEM.minPayments, prices: Object.fromEntries(["wash", "int", "both"].map(t => [t, Object.fromEntries([1, 2, 4].map(fq => [fq, [0, 1, 2].map(sz => planPrice(t, sz, fq).monthly)]))])) }),
    charges: ch.map(x => ({ kind: x.kind, amount: x.amount_cents / 100, tax: (x.tax_cents || 0) / 100, credit: (x.credit_used_cents || 0) / 100, status: x.status, error: x.error, day: x.for_day, at: x.created_at })),
    visits: visits.map(v => ({ id: v.id, day: v.day, start: v.start_utc, end: v.end_utc, pkg: v.pkg, status: v.status, done: !!v.completed_at, reason: v.cancel_reason, credit: (v.credit_cents || 0) / 100 })),
    log: await logFor(env, "m:" + id) });
}
async function memberAction(env, id, act, body, who) {
  const m = await env.DB.prepare("SELECT * FROM memberships WHERE id = ?").bind(id).first(); if (!m) return bad("Not found", 404);
  const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(m.customer_id).first();
  let r, what;
  try {
    if (act === "pause") { r = await pauseByOwner(env, m, body.months); what = "Paused " + (Math.round(+body.months) || 1) + " month(s)"; }
    else if (act === "resume") { r = await resumeByOwner(env, m); what = "Resumed"; }
    else if (act === "cancel") {
      const mode = body.mode;
      if (mode === "waive") { r = await cancelWaived(env, m, c); what = "Cancelled (no fee)"; }
      else if (mode === "finish" || mode === "fee") { r = await cancelMembership(env, m, mode === "fee" ? "now" : "finish", c); what = mode === "fee" ? "Cancelled now with the early-cancellation fee" : "Set to end after the minimum"; }
      else return bad("Pick how to cancel.");
    }
    else if (act === "plan") { r = await changePlan(env, m, String(body.type), body.freq, body.size); what = "Changed plan to " + planLabel(String(body.type), +body.freq, +body.size); }
    else if (act === "credit") {
      const cents = Math.round(parseFloat(String(body.amount || "").replace(/[$,]/g, "")) * 100);
      if (!(cents >= 100 && cents <= 100000)) return bad("Enter a credit between $1 and $1,000.");
      await env.DB.prepare("UPDATE memberships SET credit_cents = credit_cents + ?, updated_at = ? WHERE id = ?").bind(cents, Date.now(), m.id).run();
      r = { message: "Added a " + usd(cents) + " credit. It comes off their next monthly charge (before tax)." }; what = "Added " + usd(cents) + " credit" + (body.note ? ": " + cl(body.note, 120) : "");
    }
    else if (act === "retry") { if (m.status !== "past_due") return bad("There's no failed payment to retry."); const x = await retryNow(env, Object.assign({}, m)); r = { message: /charged/.test(x) ? "Paid. Their visits are unlocked." : "That didn't go through: " + x }; what = "Retried the payment: " + x; }
    else return bad("Unknown action.", 404);
  } catch (e) { return bad(e.message); }
  await ownerLog(env, who, what, "m:" + m.id);
  return json(Object.assign({ ok: true }, r));
}

// ---------- money: Square fees + payouts, yearly totals ----------
export async function syncSquare(env, full) {
  if (!squareOn(env)) return { skipped: "Square isn't connected" };
  const st = await env.DB.prepare("SELECT v FROM meta WHERE k = 'sq_sync'").first(), prev = st ? JSON.parse(st.v) : null;
  const begin = new Date(full || !prev ? Date.UTC(new Date().getUTCFullYear() - 1, 0, 1) : prev.at - 3 * 864e5).toISOString();
  let cursor = null, n = 0, pages = 0, last = 0;
  do {
    const r = await listPayments(env, begin, cursor); cursor = r.cursor; pages++;
    for (const p of r.payments) last = Math.max(last, p.created_at);
    const stmts = r.payments.map(p => env.DB.prepare("INSERT OR REPLACE INTO square_payments (id, created_at, amount_cents, fee_cents, refunded_cents, status, source, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(p.id, p.created_at, p.amount_cents, p.fee_cents, p.refunded_cents, p.status, p.source, p.note, Date.now()));
    if (stmts.length) await env.DB.batch(stmts); n += stmts.length;
  } while (cursor && pages < 10);
  // more pages left: next run picks up from the newest payment fetched (minus the 3-day overlap), so nothing is skipped
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sq_sync', ?)").bind(JSON.stringify({ at: cursor ? last + 3 * 864e5 : Date.now(), n, partial: !!cursor })).run();
  return { payments: n, more: !!cursor };
}
async function payouts(env, force) {
  if (!squareOn(env)) return null;
  const st = await env.DB.prepare("SELECT v FROM meta WHERE k = 'sq_payouts'").first(), prev = st ? JSON.parse(st.v) : null;
  if (prev && !force && Date.now() - prev.at < 30 * 60000) return prev;
  try { const list = await listPayouts(env), v = { at: Date.now(), list }; await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('sq_payouts', ?)").bind(JSON.stringify(v)).run(); return v; }
  catch (e) { return Object.assign({}, prev || { list: [] }, { error: e.message }); }
}
export async function moneyExtras(env) {
  const Y = {}, yr = ms => utcToNy(ms).key.slice(0, 4);
  const row = y => Y[y] || (Y[y] = { year: y, details: 0, members: 0, fees: 0, tips: 0, salesTax: 0, squareFees: 0, payments: 0 });
  const det = (await env.DB.prepare("SELECT paid_at, COALESCE(final_cents,0) a, COALESCE(tip_cents,0) t, COALESCE(tax_cents,0) x FROM bookings WHERE paid_at IS NOT NULL AND kind != 'member' AND status != 'cancelled'").all()).results || [];
  for (const r of det) { const x = row(yr(r.paid_at)); x.details += r.a; x.tips += r.t; x.salesTax += r.x; }
  const mem = (await env.DB.prepare("SELECT kind, amount_cents a, tax_cents x, created_at FROM membership_charges WHERE status = 'paid'").all()).results || [];
  for (const c of mem) { const x = row(yr(c.created_at)); if (c.kind === "cancel_fee") x.fees += c.a; else x.members += c.a; x.salesTax += c.x || 0; }
  const sp = (await env.DB.prepare("SELECT created_at, amount_cents, COALESCE(fee_cents,0) f FROM square_payments WHERE status = 'COMPLETED'").all()).results || [];
  for (const p of sp) { const x = row(yr(p.created_at)); x.squareFees += p.f; x.payments++; }
  row(todayKey().slice(0, 4));
  const years = Object.values(Y).sort((a, b) => b.year.localeCompare(a.year)).map(x => { const gross = x.details + x.members + x.fees + x.tips;
    return { year: x.year, details: x.details / 100, members: x.members / 100, fees: x.fees / 100, tips: x.tips / 100, gross: gross / 100, salesTax: x.salesTax / 100, squareFees: x.squareFees / 100, net: (gross - x.squareFees) / 100, squarePayments: x.payments }; });
  const feeMonths = {}; for (const p of sp) { const k = utcToNy(p.created_at).key.slice(0, 7); feeMonths[k] = (feeMonths[k] || 0) + p.f / 100; }
  const st = await env.DB.prepare("SELECT v FROM meta WHERE k = 'sq_sync'").first();
  return { years, feeMonths, squareSync: st ? JSON.parse(st.v) : null, payouts: await payouts(env), squareOn: squareOn(env) };
}

// ---------- backup ----------
async function exportAll(env) {
  const t = async q => ((await env.DB.prepare(q).all()).results || []);
  const data = { exportedAt: new Date().toISOString(), note: "Apex Detailing data backup. Photos are in Cloudflare R2 (download them per job from the dashboard).",
    customers: (await t("SELECT * FROM customers")).map(c => Object.assign(c, { email: realEmail(c.email) })), vehicles: await t("SELECT * FROM vehicles"),
    bookings: (await t("SELECT * FROM bookings")).map(b => { const o = Object.assign({}, b); delete o.token; delete o.ack_token; delete o.pay_token; return o; }),
    memberships: await t("SELECT * FROM memberships"), membership_charges: await t("SELECT * FROM membership_charges"), blockouts: await t("SELECT * FROM blockouts"),
    job_angles: await t("SELECT * FROM job_angles"), photos: await t("SELECT id, booking_id, angle_id, phase, w, h, bytes, taken_at, hidden, replaced_at, deleted_at, created_at FROM photos"),
    owner_log: await t("SELECT * FROM owner_log ORDER BY at DESC LIMIT 5000"), square_payments: await t("SELECT * FROM square_payments"),
    meta: await t("SELECT * FROM meta WHERE k NOT LIKE 'sq_payouts'") };
  return new Response(JSON.stringify(data, null, 1), { headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="apex-backup-' + todayKey() + '.json"', "Cache-Control": "no-store" } });
}

// ---------- router ----------
export async function ownerApi(req, env, url, H, p, M, body, who) {
  let m;
  // customers
  if (p === "/customers" && M === "GET") return customerList(env, url);
  if (p === "/customers" && M === "POST") {
    let f; try { f = readCustomer(body, false); } catch (e) { return bad(e.message); }
    const id = newId(), now = Date.now(), email = f.email || "c-" + id + "@no-email.invalid";
    if (f.email && await env.DB.prepare("SELECT id FROM customers WHERE email = ?").bind(f.email).first()) return bad("A customer with that email already exists. Search for them instead.", 409);
    const pin = townCoords(f.town);
    await env.DB.prepare("INSERT INTO customers (id, email, name, phone, address, town, lat, lon, notes, cars, remind, created_at, updated_at, owner_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', 1, ?, ?, ?)")
      .bind(id, email, f.name, f.phone || null, f.address || null, f.town || null, pin ? pin[0] : null, pin ? pin[1] : null, now, now, f.owner_notes || null).run();
    await ownerLog(env, who, "Added this customer", "c:" + id);
    return json({ ok: true, id });
  }
  if ((m = p.match(/^\/customers\/([a-f0-9]{18})$/))) {
    const id = m[1];
    if (M === "GET") return customerDetail(env, H, id);
    const c = await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first(); if (!c) return bad("Not found", 404);
    if (M === "POST") {
      let f; try { f = readCustomer(body, true); } catch (e) { return bad(e.message); }
      if (Object.hasOwn(f, "email")) {
        if (!f.email) f.email = NOEMAIL.test(c.email) ? c.email : "c-" + c.id + "@no-email.invalid";
        else if (f.email !== c.email && await env.DB.prepare("SELECT id FROM customers WHERE email = ? AND id != ?").bind(f.email, id).first()) return bad("Another customer already has that email.", 409);
      }
      if (Object.hasOwn(f, "town") && f.town !== c.town && !Object.hasOwn(body, "keepPin")) { const pin = townCoords(f.town); f.lat = pin ? pin[0] : null; f.lon = pin ? pin[1] : null; }
      const k = Object.keys(f); if (!k.length) return json({ ok: true });
      f.updated_at = Date.now(); k.push("updated_at");
      await env.DB.prepare("UPDATE customers SET " + k.map(x => x + " = ?").join(", ") + " WHERE id = ?").bind(...k.map(x => f[x]), id).run();
      // upcoming jobs use the new name / phone / email for reminders and receipts
      const up = ["name", "phone", "email"].filter(x => Object.hasOwn(f, x) && f[x]);
      if (up.length) await env.DB.prepare("UPDATE bookings SET " + up.map(x => x + " = ?").join(", ") + " WHERE customer_id = ? AND status = 'confirmed' AND end_utc > ?").bind(...up.map(x => f[x]), id, Date.now()).run();
      const changed = k.filter(x => !["updated_at", "lat", "lon"].includes(x));
      if (changed.some(x => x !== "owner_notes")) await ownerLog(env, who, "Edited details: " + changed.map(x => x.replace("owner_notes", "your notes")).join(", "), "c:" + id);
      return json({ ok: true });
    }
    if (M === "DELETE") {
      const n = (await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE customer_id = ? OR email = ?").bind(id, c.email).first()).n;
      const mm = (await env.DB.prepare("SELECT COUNT(*) n FROM memberships WHERE customer_id = ?").bind(id).first()).n;
      if (!n && !mm) {
        await env.DB.batch([env.DB.prepare("DELETE FROM vehicles WHERE customer_id = ?").bind(id), env.DB.prepare("DELETE FROM sessions WHERE customer_id = ?").bind(id), env.DB.prepare("DELETE FROM customers WHERE id = ?").bind(id)]);
        return json({ ok: true, deleted: true });
      }
      const live = (await env.DB.prepare("SELECT COUNT(*) n FROM bookings WHERE (customer_id = ? OR email = ?) AND status = 'confirmed' AND end_utc > ?").bind(id, c.email, Date.now()).first()).n;
      const act = await activeFor(env, id);
      if (live || act) return bad("They have " + (live ? live + " upcoming job" + (live > 1 ? "s" : "") : "an active Apex Membership") + ". Cancel " + (live ? "those" : "it") + " first.", 409);
      await env.DB.prepare("UPDATE customers SET archived_at = ?, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), id).run();
      await ownerLog(env, who, "Archived (hidden from your list; their job and payment records are kept)", "c:" + id);
      return json({ ok: true, archived: true });
    }
  }
  if ((m = p.match(/^\/customers\/([a-f0-9]{18})\/restore$/)) && M === "POST") {
    await env.DB.prepare("UPDATE customers SET archived_at = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), m[1]).run(); await ownerLog(env, who, "Restored from the archive", "c:" + m[1]); return json({ ok: true });
  }
  // vehicles
  if ((m = p.match(/^\/customers\/([a-f0-9]{18})\/vehicles$/)) && M === "POST") {
    const c = await env.DB.prepare("SELECT id FROM customers WHERE id = ?").bind(m[1]).first(); if (!c) return bad("Not found", 404);
    let f; try { f = readVehicle(body); } catch (e) { return bad(e.message); }
    const id = newId(), now = Date.now();
    await env.DB.prepare("INSERT INTO vehicles (id, customer_id, year, make, model, color, plate, size, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, c.id, f.year, f.make, f.model, f.color, f.plate, f.size, f.notes, now, now).run();
    await ownerLog(env, who, "Added vehicle: " + vname(f), "c:" + c.id);
    return json({ ok: true, id });
  }
  if ((m = p.match(/^\/vehicles\/([a-f0-9]{18})$/))) {
    const v = await env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(m[1]).first(); if (!v) return bad("Not found", 404);
    if (M === "POST") {
      let f; try { f = readVehicle(body); } catch (e) { return bad(e.message); }
      await env.DB.prepare("UPDATE vehicles SET year = ?, make = ?, model = ?, color = ?, plate = ?, size = ?, notes = ?, updated_at = ? WHERE id = ?").bind(f.year, f.make, f.model, f.color, f.plate, f.size, f.notes, Date.now(), v.id).run();
      await env.DB.prepare("UPDATE bookings SET car = ?, color = ? WHERE vehicle_id = ? AND status = 'confirmed' AND paid_at IS NULL AND end_utc > ?").bind(vname(f), f.color, v.id, Date.now()).run();
      return json({ ok: true });
    }
    if (M === "DELETE") { await env.DB.prepare("UPDATE vehicles SET deleted_at = ? WHERE id = ?").bind(Date.now(), v.id).run(); await ownerLog(env, who, "Removed vehicle: " + vname(v) + " (past jobs and photos kept)", "c:" + v.customer_id); return json({ ok: true }); }
  }

  // jobs
  if (p === "/jobs/preview" && M === "POST") {
    const c = body.customerId ? await env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(String(body.customerId)).first() : null;
    const custom = body.pkg === "custom", pkg = custom ? "full" : String(body.pkg || "full"), size = [0, 1, 2].includes(+body.size) ? +body.size : 0;
    if (!["exterior", "interior", "full"].includes(pkg)) return bad("Pick a package.");
    const adds = custom ? [] : (Array.isArray(body.adds) ? body.adds : []).filter(a => Object.hasOwn(RULES.addonPkgs, a) && RULES.addonPkgs[a].includes(pkg));
    const len = body.durationMin ? Math.max(15, Math.min(720, Math.round(+body.durationMin))) : jobMin(pkg, size, adds);
    const out = { duration: len, price: custom ? null : await priceFor(env, c, pkg, size, adds, cl(body.town, 60)) };
    const day = cl(body.day, 10), except = body.exceptId ? String(body.exceptId) : undefined;
    if (realDay(day)) {
      const info = (await H.days(env, day, 1, except))[day], ot = openTimes(day, info, len);
      out.day = { day, times: ot.times, reason: ot.reason, end: info.end, jobs: info.j, max: info.off ? RULES.maxJobsDayOff : RULES.maxJobs, winter: winterDay(day) };
    }
    return json(out);
  }
  if (p === "/jobs" && M === "POST") return createJob(env, H, body, who);
  if ((m = p.match(/^\/jobs\/([A-Z0-9]{4,8})(?:\/([a-z-]+))?(?:\/([A-Za-z0-9-]{1,40}))?$/))) {
    const b = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(m[1]).first();
    if (!b) return bad("That job doesn't exist anymore.", 404);
    const sub = m[2] || "", sub2 = m[3] || "";
    if (!sub && M === "GET") return jobDetail(env, H, b);
    if (!sub && M === "DELETE") return deleteJobRow(env, b, who);
    if (sub === "edit" && M === "POST") return editJob(env, H, b, body, who);
    if (sub === "move" && M === "POST") return moveJob(env, H, b, body, who);
    if (sub === "cancel" && M === "POST") return cancelJob(env, H, b, body, who);
    if (sub === "status" && M === "POST") return setStatus(env, b, String(body.to || ""), who);
    if (sub === "pay" && M === "POST") {
      const r = await jobAction(env, b, String(body.action || ""), { amount: body.amount, how: body.how, big: body.big ? "1" : "0" }, H);
      if (r.ok) await ownerLog(env, who, r.msg, "j:" + b.id);
      return json(r.ok ? r : Object.assign({ error: r.msg }, r), r.ok ? 200 : 400);
    }
    if (sub === "share" && M === "POST") {
      const v = body.ok === true ? 1 : body.ok === false ? 0 : null;
      await env.DB.prepare("UPDATE bookings SET share_ok = ?, share_at = ?, share_by = ? WHERE id = ?").bind(v, v == null ? null : Date.now(), v == null ? null : "owner", b.id).run();
      await ownerLog(env, who, v == null ? "Cleared the OK-to-post answer" : v ? "Marked OK to post (customer said yes)" : "Marked NOT OK to post", "j:" + b.id);
      return json({ ok: true });
    }
    if (sub === "send-photos" && M === "POST") {
      if (!storageOn(env)) return bad("Photo storage isn't turned on yet.", 503);
      try { const r = await sendPhotosEmail(env, b, H); await ownerLog(env, who, r.sent ? "Sent the photos to " + b.email : "Opened the photo gallery (no email on file)", "j:" + b.id); return json(Object.assign({ ok: true }, r)); }
      catch (e) { return bad(e.message); }
    }
    if (sub === "angles" && M === "POST" && !sub2) { try { const id = await addAngle(env, b, body.name); return json({ ok: true, id }); } catch (e) { return bad(e.message); } }
    if (sub === "angles" && M === "POST" && sub2) { try { await setAngle(env, b, sub2, body); return json({ ok: true }); } catch (e) { return bad(e.message); } }
    return null;
  }
  // photo files + photo actions (the upload itself is handled in adminApi before the JSON body is read)
  if ((m = p.match(/^\/photos\/([a-f0-9-]{16,40})(?:\/(hide|delete))?$/i))) {
    const ph = await env.DB.prepare("SELECT p.*, a.name angle, b.name cust FROM photos p LEFT JOIN job_angles a ON a.id = p.angle_id LEFT JOIN bookings b ON b.id = p.booking_id WHERE p.id = ?").bind(m[1]).first();
    if (!ph) return bad("Not found", 404);
    if (!m[2] && M === "GET") return photoFile(env, ph, url.searchParams.get("t") === "1", url.searchParams.get("dl") === "1" ? [ph.cust, ph.angle, ph.phase === "before" ? "Before" : "After"].filter(Boolean).join(" - ") + ".jpg" : null);
    if (m[2] === "hide" && M === "POST") { await hidePhoto(env, ph.id, body.hidden !== false); return json({ ok: true }); }
    if (m[2] === "delete" && M === "POST") { await deletePhoto(env, ph.id); await ownerLog(env, who, "Deleted a photo (" + (ph.angle || "") + " " + ph.phase + ")", "j:" + ph.booking_id); return json({ ok: true }); }
  }

  // members
  if ((m = p.match(/^\/members\/([a-f0-9]{18})$/)) && M === "GET") return memberDetail(env, m[1]);
  if ((m = p.match(/^\/members\/([a-f0-9]{18})\/(pause|resume|cancel|plan|credit|retry)$/)) && M === "POST") return memberAction(env, m[1], m[2], body, who);

  // money extras
  if (p === "/money/square-sync" && M === "POST") {
    try { const r = await syncSquare(env, body.full === true); await payouts(env, true); return json(Object.assign({ ok: true }, r)); } catch (e) { return bad("Square: " + e.message, 502); }
  }
  // settings
  if (p === "/settings/edit" && M === "GET") return json(currentSettings());
  if (p === "/settings" && M === "POST") { try { const s = await saveSettings(env, body, who); await ownerLog(env, who, "Changed settings", "settings"); return json({ ok: true, settings: s }); } catch (e) { return bad(e.message); } }
  if (p === "/settings/reset" && M === "POST") { const s = await resetSettings(env); await ownerLog(env, who, "Reset settings to the defaults", "settings"); return json({ ok: true, settings: s }); }
  if (p === "/export" && M === "GET") return exportAll(env);
  return null;
}
