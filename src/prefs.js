// Two customer choices that show up all over the site, emails and dashboard:
//  1. Scent: for interior work (Interior, Full Detail and their member visits; not Nick's custom jobs) the customer picks one of
//     Nick's scents or "No scent". The list lives in settings (RULES.scents). A booking keeps the scent's name, so editing the
//     list later doesn't change old jobs.
//  2. Marketing photos (Terms §10, Nov 2): by booking, customers agree we may feature photos of their car (plates and address
//     hidden) unless they opt out. The answer belongs to the CUSTOMER (customers.photos_ok / photos_at / photos_by) and is
//     copied onto each of their bookings (bookings.share_ok / share_at / share_by) so jobs show it:
//       1 = OK, 0 = opted out, NULL = never answered (jobs Nick added for someone who hasn't agreed to the Terms online).
//       by: "terms" (agreed by booking), "customer" (their own choice), "owner" (Nick recorded it).
//     An opt-out always wins: anyone holding a booking link can opt OUT, but only the signed-in customer (their account) or Nick
//     can switch an opt-out back to OK (audit Nov 2: a stranger could book with someone's email and use that booking's link).
import { RULES } from "./sched.js";

export const NO_SCENT = "No scent";
export const scentApplies = pkg => pkg === "interior" || pkg === "full";
export const scentFor = b => !!b && scentApplies(b.pkg) && !b.custom_name;   // a job that can have a scent
export const scentList = () => (Array.isArray(RULES.scents) ? RULES.scents : []);

// check a scent sent by a browser or the dashboard; "" / null means No scent. keep = the job's current scent (may be retired from the list)
export function pickScent(pkg, v, keep) {
  if (!scentApplies(pkg)) return { scent: null };
  if (v != null && typeof v !== "string") return { err: "Pick a scent from the list." };
  const s = String(v == null ? "" : v).trim();
  if (!s || s.toLowerCase() === NO_SCENT.toLowerCase()) return { scent: NO_SCENT };
  if (keep && s === keep) return { scent: keep };
  const hit = scentList().find(x => x.toLowerCase() === s.toLowerCase());
  return hit ? { scent: hit } : { err: "That scent isn't offered anymore. Pick another." };
}

// ---------- marketing photos ----------
async function customerOf(env, customerId, email) {
  if (customerId) { const c = await env.DB.prepare("SELECT id, email, photos_ok, photos_at, photos_by FROM customers WHERE id = ?").bind(customerId).first(); if (c) return c; }
  const e = String(email || "").trim().toLowerCase();
  return e ? await env.DB.prepare("SELECT id, email, photos_ok, photos_at, photos_by FROM customers WHERE email = ?").bind(e).first() : null;
}
// the customer's current answer: their account's answer, else the latest one on their bookings (jobs from before this existed)
export async function photoPref(env, customerId, email) {
  const c = await customerOf(env, customerId, email);
  if (c) return c.photos_ok == null ? null : { ok: c.photos_ok, at: c.photos_at, by: c.photos_by };
  const r = await env.DB.prepare("SELECT share_ok, share_at, share_by FROM bookings WHERE (customer_id = ? OR email = ?) AND share_ok IS NOT NULL ORDER BY share_at DESC, created_at DESC LIMIT 1")
    .bind(c ? c.id : customerId || "", String((c && c.email) || email || "").toLowerCase()).first();
  return r ? { ok: r.share_ok, at: r.share_at, by: r.share_by } : null;
}
// write one answer to the customer and every booking of theirs (by customer id or, for old jobs, by email)
async function writeAll(env, c, b, v, at, by) {
  if (c) await env.DB.prepare("UPDATE customers SET photos_ok = ?, photos_at = ?, photos_by = ? WHERE id = ?").bind(v, at, by, c.id).run();
  const id = c ? c.id : (b && b.customer_id) || null, email = String((c && c.email) || (b && b.email) || "").toLowerCase();
  await env.DB.prepare("UPDATE bookings SET share_ok = ?, share_at = ?, share_by = ? WHERE (? IS NOT NULL AND customer_id = ?) OR (? != '' AND email = ?) OR id = ?")
    .bind(v, at, by, id, id, email, email, (b && b.id) || "").run();
  if (b) Object.assign(b, { share_ok: v, share_at: at, share_by: by });
}
// what a new booking starts with (call once the customer row exists): an opt-out ticked now or before always carries over;
// otherwise their earlier answer, else "OK by the Terms" when they agreed online now, else never asked.
// trusted = the person booking is the account's owner (new account, or signed in as it): only then does "agreed" become the account's answer
export async function photoStart(env, customerId, email, { optOut, agreed, trusted }) {
  const now = Date.now(), c = await customerOf(env, customerId, email);
  if (optOut) { if (c) await writeAll(env, c, null, 0, now, "customer"); return { share_ok: 0, share_at: now, share_by: "customer" }; }
  const p = await photoPref(env, customerId, email);
  if (p) return { share_ok: p.ok, share_at: p.at || now, share_by: p.by };
  if (!agreed) return { share_ok: null, share_at: null, share_by: null };
  if (c && trusted) await env.DB.prepare("UPDATE customers SET photos_ok = 1, photos_at = ?, photos_by = 'terms' WHERE id = ? AND photos_ok IS NULL").bind(now, c.id).run();
  return { share_ok: 1, share_at: now, share_by: "terms" };
}
// change the answer for a customer. how: "account" (signed in), "owner" (Nick), "link" (a booking link: can't undo an opt-out).
// ok: true / false, or null (owner only: forget the answer; refused when it's the customer's own opt-out)
export async function setPhotoPref(env, b, ok, how) {
  const c = await customerOf(env, b && b.customer_id, b && b.email), cur = await photoPref(env, c ? c.id : b && b.customer_id, c ? c.email : b && b.email);
  const by = how === "owner" ? "owner" : "customer", now = Date.now();
  if (ok === false) { await writeAll(env, c, b, 0, now, by); return { ok: true }; }
  if (ok === true) {
    if (how === "link") {   // a booking link: never undoes an opt-out, and a "yes" only covers this booking
      if (cur && cur.ok === 0) return { ok: false, signIn: true, msg: "You opted out of marketing photos for all your bookings. To change that, sign in to your account (My details) or text us." };
      await env.DB.prepare("UPDATE bookings SET share_ok = 1, share_at = ?, share_by = 'customer' WHERE id = ?").bind(now, b.id).run();
      Object.assign(b, { share_ok: 1, share_at: now, share_by: "customer" }); return { ok: true };
    }
    await writeAll(env, c, b, 1, now, by); return { ok: true };
  }
  if (how !== "owner") return { ok: false, msg: "Bad request" };
  if (cur && cur.ok === 0 && cur.by === "customer") return { ok: false, msg: "They opted out themselves, so it stays. If they told you it's OK now, tap OK to feature." };
  await writeAll(env, c, b, null, null, null); return { ok: true };
}
// plain words for pages and emails
export function photoWords(b) {
  if (b.share_ok == null) return "Not asked";
  return b.share_ok ? "OK to feature (plate and address hidden)" : "Opted out";
}
