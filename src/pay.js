// Getting paid: Nick's "job done" page, the customer's pay / tip page, receipts.
import { squareOn, saveCard, charge, ensureSquareCustomer } from "./square.js";
import { send, layout, rows, button, h } from "./email.js";
import { TAX, taxCents } from "./pricing.js";

const methodLabel = m => m === "card_on_file" ? "card on file" : m === "online" ? "paid online" : /^in_person/.test(m || "") ? "in person (" + (m.split(":")[1] || "") + ")" : (m || "");
const money = c => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const NAMES = { exterior: "Exterior", interior: "Interior", full: "Full Detail" };
const TAX_LABEL = TAX.name + " (" + TAX.pct + ")", TAX_UNITS = Math.round(TAX.rate * 100000);
// biggest tip the pay page takes: half the price before tax, at least $50 (a bigger one: text us). Audit IA-039.
const tipLimit = sub => Math.max(5000, Math.round(sub / 2));
// what the customer owes for a detail: price before tax (Nick's final amount, or the estimate) + NJ sales tax
// (final amounts set before sales tax started have tax_cents NULL: keep the amount that was already emailed)
function bill(b) { const sub = b.final_cents || (b.quote || 0) * 100, tax = b.final_cents != null ? (b.tax_cents || 0) : taxCents(sub); return { sub, tax, total: sub + tax }; }
const json = (d, s) => new Response(JSON.stringify(d), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const html = (b, s) => new Response(b, { status: s || 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
const tok = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), x => x.toString(16).padStart(2, "0")).join("");

export function squareScript(env) { return env.SQUARE_ENV === "production" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js"; }
export function publicConfig(env) { return squareOn(env) ? { appId: env.SQUARE_APP_ID, locationId: env.SQUARE_LOCATION_ID, script: squareScript(env), sandbox: env.SQUARE_ENV !== "production" } : null; }

async function customerFor(env, b) {
  return b.customer_id ? env.DB.prepare("SELECT * FROM customers WHERE id = ?").bind(b.customer_id).first() : env.DB.prepare("SELECT * FROM customers WHERE email = ?").bind(b.email).first();
}
async function ensurePayToken(env, b) {
  if (b.pay_token) return b.pay_token;
  b.pay_token = tok();
  await env.DB.prepare("UPDATE bookings SET pay_token = ? WHERE id = ?").bind(b.pay_token, b.id).run();
  return b.pay_token;
}

// ---------- receipts ----------
async function emailReceipt(env, b, opts) {
  const site = env.SITE_URL, first = b.name.split(" ")[0];
  const tipLink = opts.offerTip ? site + "/pay/" + b.pay_token + "?tip=1" : null;
  const tax = opts.tax || 0, tip = opts.tip || 0, total = (opts.amount || 0) + tax + tip;
  const subject = opts.tipOnly ? "Thanks for the tip, " + first + "!" : "Receipt: your " + NAMES[b.pkg] + " · " + money(total);
  const body = (opts.tipOnly ? `<h1 style="font-size:24px;margin:0 0 8px">Thank you, ${h(first)}!</h1><p style="margin:0;color:#444;line-height:1.55">We got your ${money(opts.tip)} tip. It really means a lot.</p>`
      : `<h1 style="font-size:24px;margin:0 0 8px">Thanks, ${h(first)}. You're all set.</h1><p style="margin:0;color:#444;line-height:1.55">Here's your receipt for today's detail.</p>`) +
    rows(opts.tipOnly ? [["Detail", NAMES[b.pkg] + " · " + (b.car || "")], ["Tip", money(tip)], ["Paid with", opts.method], ["Booking code", b.id]]
      : [["Detail", NAMES[b.pkg] + " · " + (b.car || "")], ["Price", money(opts.amount)], [TAX_LABEL, money(tax)], ["Tip", tip ? money(tip) : ""], ["Total paid", money(total)],
        ["Paid with", opts.method], ["Booking code", b.id]]) +
    (opts.receipt ? `<p style="margin:0 0 14px"><a href="${h(opts.receipt)}" style="color:#111">View the Square receipt</a></p>` : "") +
    (tipLink ? `<p style="margin:0 0 6px;font-weight:700">Happy with it?</p><p style="margin:0 0 16px;color:#444">Tips are never expected, always appreciated.</p><p style="margin:0 0 18px">${button(tipLink, "Add a tip")}</p>` : "") +
    (opts.tipOnly ? "" : `<p style="margin:0 0 6px;font-weight:700">How did we do?</p><p style="margin:0 0 18px;color:#444;line-height:1.55">Just reply to this email. We read every one, and if anything isn't right, we'll come back and fix it within 48 hours.</p>`) +
    `<p style="margin:0">${button(site + "/#book", "Book your next detail", false)}</p>`;
  return send(env, { to: b.email, subject, html: layout(subject, body, opts.tipOnly ? "Thanks for the tip" : "Receipt " + money(total), site + "/email-logo.png") });
}

async function emailPayLink(env, b, cents, tax) {
  const site = env.SITE_URL, first = b.name.split(" ")[0], link = site + "/pay/" + b.pay_token, total = cents + tax;
  const subject = "Your detail is done: " + money(total) + " due";
  const body = `<h1 style="font-size:24px;margin:0 0 8px">All done, ${h(first)}!</h1><p style="margin:0;color:#444;line-height:1.55">Thanks for having us out. You can pay securely online below, and add a tip if you'd like.</p>` +
    rows([["Detail", NAMES[b.pkg] + " · " + (b.car || "")], ["Price", money(cents)], [TAX_LABEL, money(tax)], ["Amount due", money(total)], ["Booking code", b.id]]) + `<p style="margin:0">${button(link, "Pay " + money(total))}</p>`;
  return send(env, { to: b.email, subject, html: layout(subject, body, money(total) + " due", site + "/email-logo.png") });
}

// ---------- one payment at a time per bill ----------
// A payment claims the booking (paying_at) before charging the card; a second payment for the same bill is refused
// until the first one finishes. A claim older than 2 minutes counts as abandoned. Square's own idempotency keys can't
// do this because the amounts (and so the keys) differ between a pay link, a tip and Nick's "Charge card".
// Needs migration 0010 (bookings.paying_at). Until that column exists, payments work as before (no claim).
const CLAIM_MS = 120000;
let claimCol = { ok: false, at: 0 };
async function claimsOn(env) {
  if (claimCol.ok || Date.now() - claimCol.at < 60000) return claimCol.ok;
  try { await env.DB.prepare("SELECT paying_at FROM bookings LIMIT 0").all(); claimCol = { ok: true, at: Date.now() }; }
  catch (e) { claimCol = { ok: false, at: Date.now() }; console.log("payment claims are off until migration 0010 (bookings.paying_at) is applied"); }
  return claimCol.ok;
}
async function claimBill(env, id, tip) {
  if (!(await claimsOn(env))) return true;
  const now = Date.now(), cond = tip ? "paid_at IS NOT NULL AND COALESCE(tip_cents, 0) = 0" : "paid_at IS NULL";
  return !!(await env.DB.prepare("UPDATE bookings SET paying_at = ? WHERE id = ? AND " + cond + " AND (paying_at IS NULL OR paying_at < ?) RETURNING id").bind(now, id, now - CLAIM_MS).first());
}
const releaseBill = async (env, id) => { if (await claimsOn(env)) await env.DB.prepare("UPDATE bookings SET paying_at = NULL WHERE id = ?").bind(id).run().catch(() => {}); };
const clearClaim = async env => (await claimsOn(env)) ? ", paying_at = NULL" : "";   // added to the UPDATE that records a payment
const BUSY_MSG = "A payment for this job is going through right now. Refresh this page in a minute.";

// ---------- Nick's job page: /job/<ack_token> ----------
export async function jobRoute(req, env, url, H) {
  const m = url.pathname.match(/^\/job\/([a-f0-9]{36})(?:\/(charge|link|inperson|done|weather|undo))?$/);
  if (!m) return html(H.page("Not found", "<h1>Link not found</h1>"), 404);
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE ack_token = ?").bind(m[1]).first();
  if (!b) return html(H.page("Not found", "<h1>Job not found</h1>"), 404);
  // only charge the card the customer chose for THIS booking
  const c = await customerFor(env, b), card = b.card ? JSON.parse(b.card) : null;
  let msg = "", ok = false;

  if (req.method === "POST" && m[2] === "weather" && b.status === "confirmed" && !b.paid_at) {
    const credit = await H.cancelByUs(env, b); ok = true;
    msg = "Cancelled and the customer was emailed." + (credit ? " Added a " + money(credit) + " credit to their membership." : " They were asked to pick a new time.");
  } else if (req.method === "POST" && m[2] === "done" && b.kind === "member" && b.status === "confirmed" && !b.completed_at) {
    await env.DB.prepare("UPDATE bookings SET completed_at = ?, paid_at = ?, paid_method = 'membership', final_cents = 0 WHERE id = ?").bind(Date.now(), Date.now(), b.id).run();
    Object.assign(b, { completed_at: Date.now(), paid_at: Date.now(), paid_method: "membership" }); ok = true; msg = "Marked done. Nice work!";
  } else if (req.method === "POST" && m[2] === "undo" && b.paid_at && /^in_person/.test(b.paid_method || "") && b.status === "confirmed") {
    // undo a "paid in person" tap (mis-tap or wrong amount): back to not paid
    await env.DB.prepare("UPDATE bookings SET paid_at = NULL, paid_method = NULL, final_cents = NULL, tax_cents = NULL WHERE id = ?").bind(b.id).run();
    Object.assign(b, { paid_at: null, paid_method: null, final_cents: null, tax_cents: null }); ok = true; msg = "Undone. It's marked not paid again.";
  } else if (req.method === "POST" && m[2] && m[2] !== "undo" && !b.paid_at && b.status === "confirmed" && b.kind !== "member") {
    const fd = await req.formData(), raw = String(fd.get("amount") || "").trim(), dollars = /^\$?\d+(\.\d{1,2})?$/.test(raw.replace(/,/g, "")) ? parseFloat(raw.replace(/[$,]/g, "")) : NaN, cents = Math.round(dollars * 100);
    const tax = taxCents(cents), total = cents + tax, split = " (" + money(cents) + " + " + money(tax) + " tax)", est = (b.quote || 0) * 100;
    if (cents > 200000) msg = "That's over the $2,000 limit for one job. Check the amount (price before tax).";
    else if (!(cents >= 100)) msg = "Enter the price before tax as a number, like 179.";
    else if (est && cents > 2 * est && fd.get("big") !== "1") msg = "That's more than double the " + money(est) + " estimate. Check the amount and confirm it when asked.";
    else if (m[2] === "inperson") {
      const how = String(fd.get("how") || "cash").slice(0, 20);
      const free = (await claimsOn(env)) ? " AND (paying_at IS NULL OR paying_at < " + (Date.now() - CLAIM_MS) + ")" : "";
      const done = await env.DB.prepare("UPDATE bookings SET completed_at = ?, final_cents = ?, tax_cents = ?, paid_at = ?, paid_method = ? WHERE id = ? AND paid_at IS NULL" + free + " RETURNING id")
        .bind(Date.now(), cents, tax, Date.now(), "in_person:" + how, b.id).first();
      if (!done) msg = BUSY_MSG; else {
      Object.assign(b, { paid_at: Date.now(), completed_at: Date.now(), final_cents: cents, tax_cents: tax, paid_method: "in_person:" + how }); ok = true; msg = "Marked paid in person (" + how + "): " + money(total) + split + ". Receipt emailed.";
      // in-person customers get a receipt too (audit IA-051)
      await emailReceipt(env, b, { amount: cents, tax, method: "In person (" + ({ cash: "cash", card: "card / Tap to Pay", other: "Venmo / other" }[how] || how) + ")", offerTip: false }).catch(() => {});
      }
    } else if (m[2] === "link") {
      await ensurePayToken(env, b);
      await env.DB.prepare("UPDATE bookings SET completed_at = ?, final_cents = ?, tax_cents = ? WHERE id = ?").bind(Date.now(), cents, tax, b.id).run();
      Object.assign(b, { final_cents: cents, tax_cents: tax, completed_at: Date.now() });
      await emailPayLink(env, b, cents, tax); ok = true; msg = "Sent " + b.email + " a link to pay " + money(total) + split + ".";
    } else if (m[2] === "charge") {
      if (!card || !squareOn(env)) msg = "No saved card for this customer. Send a pay link instead.";
      else if (!(await claimBill(env, b.id, false))) msg = BUSY_MSG;
      else {
        let jobCharged = false;
        try {
          await ensurePayToken(env, b);
          const p = await charge(env, { source: card.id, amount: total, customerId: c.square_customer_id, reference: b.id, note: "Apex Detailing " + NAMES[b.pkg] + " · " + b.id + " · " + money(cents) + " + " + money(tax) + " " + TAX.name, email: b.email, idem: "job-" + b.id + "-" + total }); jobCharged = true;
          await env.DB.prepare("UPDATE bookings SET completed_at = ?, final_cents = ?, tax_cents = ?, paid_at = ?, paid_method = 'card_on_file', payment_id = ?, receipt_url = ?" + (await clearClaim(env)) + " WHERE id = ?").bind(Date.now(), cents, tax, Date.now(), p.id, p.receipt, b.id).run();
          Object.assign(b, { paid_at: Date.now(), completed_at: Date.now(), final_cents: cents, tax_cents: tax, paid_method: "card_on_file" }); ok = true;
          msg = "Charged " + money(total) + split + " to " + card.brand + " ending " + card.last4 + ". Receipt sent.";
          await emailReceipt(env, b, { amount: cents, tax, method: card.brand + " ending " + card.last4, receipt: p.receipt, offerTip: true }).catch(() => {});
        } catch (e) { if (!jobCharged) await releaseBill(env, b.id); msg = jobCharged ? "The card was charged, but saving it here failed. Check Square before charging again." : "Charge failed: " + e.message + " You can send them a pay link instead."; }
      }
    }
  }

  const est = (b.quote || 0) * 100, due = b.final_cents || est;
  const weatherBtn = b.status === "confirmed" && !b.paid_at ? `<form method="post" action="/job/${b.ack_token}/weather" onsubmit="return confirm('Cancel this job and email the customer?${b.kind === "member" ? " They get a full credit." : ""}')" style="margin-top:22px"><button class="btn d" style="width:100%">We had to cancel (weather or our side)</button></form><p class="note">${b.kind === "member" ? "Members get a full credit for that visit." : "The customer gets an email asking them to pick a new time."}</p>` : "";
  if (b.kind === "member") {
    const st = b.status === "cancelled" ? "Cancelled" : b.completed_at ? "Done" : "Scheduled";
    return html(H.page("Job", `<h1>${h(H.pkgName(b))} · ${h(b.name)}</h1><p class="sub">${h(H.whenText(b))}</p>
      ${msg ? `<p class="note" style="color:${ok ? "#c8f7c5" : "#ffb4ab"}">${h(msg)}</p>` : ""}
      <div class="card"><div class="r"><span>Status</span><b>${st}</b></div><div class="r"><span>Payment</span><b>Included in their Apex Membership</b></div></div>
      ${H.summaryCard(b)}
      ${b.status === "confirmed" && !b.completed_at ? `<div class="acts"><form method="post" action="/job/${b.ack_token}/done"><button class="btn" style="width:100%">Mark visit done</button></form></div>` : ""}${weatherBtn}`));
  }
  const B = bill(b), paidTotal = (b.final_cents || 0) + (b.tax_cents || 0);
  const status = b.status === "cancelled" ? (b.paid_at ? "Cancelled, but paid " + money(paidTotal + (b.tip_cents || 0)) + ": refund it in Square" : "Cancelled") : b.paid_at ? "Paid " + money(paidTotal) + (b.tax_cents ? " incl. tax" : "") + (b.tip_cents ? " + " + money(b.tip_cents) + " tip" : "") + " · " + methodLabel(b.paid_method) : b.final_cents ? "Waiting on payment (" + money(B.total) + " link sent)" : "Not paid yet";
  const undoBtn = b.paid_at && /^in_person/.test(b.paid_method || "") && b.status === "confirmed" ? `<form method="post" action="/job/${b.ack_token}/undo" onsubmit="return confirm('Mark this job as not paid again?')" style="margin-top:18px"><button class="btn g" style="width:100%">Undo "paid in person"</button></form>` : "";
  const forms = b.paid_at || b.status !== "confirmed" ? "" : `
    <h2>Job done? Get paid</h2>
    <form method="post" id="jf"><label class="note" for="amt">Price before tax (estimate was ${money(est)}${b.travel_fee ? ", includes $" + b.travel_fee + " travel" : ""})</label>
    <div style="display:flex;align-items:center;gap:8px;margin:8px 0 12px"><span style="font-size:22px">$</span><input id="amt" name="amount" inputmode="decimal" value="${(due / 100).toFixed(due % 100 ? 2 : 0)}" style="flex:1;min-height:52px;border-radius:14px;border:0;padding:0 14px;font-family:inherit;font-size:22px;font-weight:600;background:rgba(255,255,255,.08);color:#ededed"></div>
    <div class="card" style="margin-bottom:4px"><div class="r"><span>${h(TAX_LABEL)}</span><b id="taxAmt">${money(taxCents(due))}</b></div><div class="r"><span>Customer pays</span><b id="totAmt" style="font-size:20px">${money(due + taxCents(due))}</b></div></div>
    <script>(function(){var a=document.getElementById("amt"),t=document.getElementById("taxAmt"),T=document.getElementById("totAmt"),f=document.getElementById("jf"),EST=${est};function m(c){return "$"+(c/100).toFixed(c%100?2:0);}
      f.addEventListener("submit",function(e){var s=e.submitter,act=(s&&s.getAttribute("formaction"))||"",c=Math.round((parseFloat(String(a.value).replace(/[$,]/g,""))||0)*100),tot=T.textContent,q;
        if(!/^\\$?[\\d,]+(\\.\\d{1,2})?$/.test(String(a.value).trim())){e.preventDefault();alert("Enter the price before tax as a number, like 179.");return;}
        if(/charge$/.test(act))q="Charge "+tot+" (with tax) to "+(s.dataset.card||"the saved card")+"?";else if(/inperson$/.test(act))q="Mark paid in person ("+f.how.value+"): "+tot+" with tax?";else if(/link$/.test(act))q="Email them a link to pay "+tot+"?";
        if(q&&!confirm(q)){e.preventDefault();return;}
        if(EST&&c>2*EST){if(!confirm("That's more than double the "+m(EST)+" estimate. Continue with "+tot+"?")){e.preventDefault();return;}f.big.value="1";}});
      function up(){var c=Math.round((parseFloat(String(a.value).replace(/[^\\d.]/g,""))||0)*100),x=c>0?Math.floor((c*${TAX_UNITS}+50000)/100000):0;t.textContent=m(x);T.textContent=m(c+x);}a.addEventListener("input",up);up();})();</script>
    <input type="hidden" name="how" value="cash"><input type="hidden" name="big" value="0">
    <div class="acts">
      ${card && squareOn(env) ? `<button class="btn" formaction="/job/${b.ack_token}/charge" data-card="${h(card.brand)} ending ${h(card.last4)}">Charge ${h(card.brand)} ending ${h(card.last4)}</button>` : ""}
      ${squareOn(env) ? `<button class="btn ${card ? "g" : ""}" formaction="/job/${b.ack_token}/link">Email them a pay link</button>` : ""}
      <button class="btn g" formaction="/job/${b.ack_token}/inperson" onclick="this.form.how.value='cash'">Paid in person: cash</button>
      <button class="btn g" formaction="/job/${b.ack_token}/inperson" onclick="this.form.how.value='card'">Paid in person: card / Tap to Pay</button>
      <button class="btn g" formaction="/job/${b.ack_token}/inperson" onclick="this.form.how.value='other'">Paid in person: Venmo / other</button>
    </div></form>
    <p class="note">Paid in person? Collect the "Customer pays" total, which includes ${h(TAX.name)}. Charging a saved card or the pay link adds the tax automatically and sends a receipt with an optional "Add a tip" button. Tips aren't taxed.</p>`;
  return html(H.page("Job", `<h1>${h(NAMES[b.pkg])} · ${h(b.name)}</h1><p class="sub">${h(H.whenText(b))}</p>
    ${msg ? `<p class="note" style="color:${ok ? "#c8f7c5" : "#ffb4ab"}">${h(msg)}</p>` : ""}
    <div class="card"><div class="r"><span>Status</span><b>${h(status)}</b></div><div class="r"><span>Saved card</span><b>${card ? h(card.brand + " ending " + card.last4) : "None"}</b></div></div>
    ${H.summaryCard(b)}${forms}${undoBtn}${weatherBtn}`));
}

// ---------- customer pay / tip page: /pay/<pay_token> ----------
export async function payPage(req, env, url, H) {
  const t = (url.pathname.split("/")[2] || "");
  const b = /^[a-f0-9]{36}$/.test(t) ? await env.DB.prepare("SELECT * FROM bookings WHERE pay_token = ?").bind(t).first() : null;
  if (!b) return html(H.page("Not found", "<h1>Link not found</h1><p class='sub'>Text us at (732) 206-7084.</p>"), 404);
  if (b.status !== "confirmed" && !b.paid_at) return html(H.page("Cancelled", `<h1>This job was cancelled</h1><p class="sub">There's nothing to pay. Questions? Text us at (732) 206-7084.</p>`));
  const c = await customerFor(env, b), card = c && c.card ? JSON.parse(c.card) : null, cfg = publicConfig(env);
  const tipMode = !!b.paid_at;
  if (tipMode && b.tip_cents) return html(H.page("Thank you", `<div class="ok">✓</div><h1>Thank you!</h1><p class="sub">We got your ${money(b.tip_cents)} tip.</p>`));
  if (tipMode && !/^card_on_file|^online/.test(b.paid_method || "")) return html(H.page("Thank you", `<div class="ok">✓</div><h1>You're all paid up</h1><p class="sub">Thanks for choosing Apex.</p>`));
  if (!cfg) return html(H.page("Pay", "<h1>Online payment isn't set up yet</h1><p class='sub'>Text us at (732) 206-7084.</p>"));
  const B = bill(b), due = tipMode ? 0 : B.total, base = B.sub, paid = (b.final_cents || 0) + (b.tax_cents || 0);   // tips are a % of the price before tax
  const tips = [0, 15, 20, 25].map(p => ({ p, c: Math.round(base * p / 100 / 100) * 100 })), tipCap = tipLimit(base);
  return html(H.page(tipMode ? "Add a tip" : "Pay", `
  <h1>${tipMode ? "Add a tip" : "Pay for your detail"}</h1><p class="sub">${h(NAMES[b.pkg])} · ${h(b.car || "")} · ${h(H.whenText(b))}</p>
  <div class="card">${tipMode ? `<div class="r"><span>Paid</span><b>${money(paid)}</b></div>` : `<div class="r"><span>Price</span><b>${money(B.sub)}</b></div><div class="r"><span>${h(TAX_LABEL)}</span><b>${money(B.tax)}</b></div><div class="r"><span>Amount due</span><b>${money(due)}</b></div>`}</div>
  <h2>${tipMode ? "How much?" : "Add a tip?"} <span class="note">Never expected, always appreciated</span></h2>
  <div class="ts" id="tips">${tips.filter(x => !tipMode || x.p).map((x, i) => `<button type="button" data-c="${x.c}" ${!tipMode && i === 0 ? 'aria-pressed="true"' : ""}>${x.p ? x.p + "% · " + money(x.c) : "No tip"}</button>`).join("")}<button type="button" data-c="custom">Other</button></div>
  <input id="tipOther" inputmode="decimal" placeholder="Tip amount, like 25" hidden style="margin-top:10px;width:100%;min-height:48px;border-radius:12px;border:0;padding:0 14px;font-family:inherit;font-size:16px;font-weight:600;background:rgba(255,255,255,.08);color:#ededed">
  <h2>Card</h2>
  ${card ? `<label class="r" style="cursor:pointer"><span><input type="radio" name="src" value="saved" checked> ${h(card.brand)} ending ${h(card.last4)}</span></label><label class="r" style="cursor:pointer"><span><input type="radio" name="src" value="new"> Use a different card</span></label>` : ""}
  <div id="cardBox" ${card ? "hidden" : ""} style="margin-top:10px;background:#fff;border-radius:14px;padding:6px 10px"><div id="card-container"></div></div>
  ${c ? `<label class="r" id="saveRow" style="cursor:pointer;justify-content:flex-start;gap:10px" ${card ? "hidden" : ""}><input type="checkbox" id="saveCard" style="width:20px;height:20px;margin:2px 0 0;flex:none"><span style="color:#d6d6d6">Save this card for future details${card ? " (replaces your " + h(card.brand) + " ending " + h(card.last4) + ", including for Apex Membership)" : " and Apex Membership"}</span></label>` : ""}
  ${cfg.sandbox ? `<p class="note">Test mode: use card 4111 1111 1111 1111, any future date, any CVV, ZIP 12345.</p>` : ""}
  <div class="acts"><button class="btn" id="payBtn">${tipMode ? "Send tip" : "Pay " + money(due)}</button></div>
  <p class="note" id="payMsg" role="alert"></p>
  <script src="${cfg.script}"></script>
  <script>
  (function(){
    var due=${due}, tipMode=${tipMode}, tip=0, CAP=${tipCap}, cardObj=null, btn=document.getElementById("payBtn"), msg=document.getElementById("payMsg"), SAVED=${JSON.stringify(card ? card.brand + " ending " + card.last4 : "")};
    function money(c){return "$"+(c/100).toFixed(c%100?2:0);}
    function label(){ var t=due+tip; btn.textContent=tipMode?("Send "+(tip?"$"+(tip/100).toFixed(tip%100?2:0)+" ":"")+"tip"):("Pay $"+(t/100).toFixed(t%100?2:0)); }
    document.getElementById("tips").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;[].forEach.call(this.children,function(x){x.setAttribute("aria-pressed",String(x===b));});
      var o=document.getElementById("tipOther"); if(b.dataset.c==="custom"){o.hidden=false;o.focus();tip=Math.round((parseFloat(o.value)||0)*100);}else{o.hidden=true;tip=+b.dataset.c;} label();});
    document.getElementById("tipOther").addEventListener("input",function(){tip=Math.round((parseFloat(this.value.replace(/[^\\d.]/g,""))||0)*100);label();});
    [].forEach.call(document.querySelectorAll('input[name=src]'),function(r){r.addEventListener("change",function(){document.getElementById("cardBox").hidden=this.value!=="new";var sr=document.getElementById("saveRow");if(sr)sr.hidden=this.value!=="new";if(this.value==="new")mount();});});
    function mount(){ if(cardObj||!window.Square)return; var p=Square.payments(${JSON.stringify(cfg.appId)},${JSON.stringify(cfg.locationId)}); p.card().then(function(c){cardObj=c;return c.attach("#card-container");}).catch(function(e){msg.textContent="The card form didn't load. Refresh, or text us at (732) 206-7084.";}); }
    if(!window.Square){msg.textContent="The secure card form didn't load. Refresh the page, or text us at (732) 206-7084.";}
    if(${card ? "false" : "true"}) mount();
    label();
    btn.addEventListener("click",function(){
      if(tipMode&&!tip){msg.textContent="Pick a tip amount.";return;}
      if(tip>CAP){msg.textContent="For a tip over "+money(CAP)+", text us at (732) 206-7084. Thank you!";return;}
      var saved=document.querySelector('input[name=src]:checked'); saved=saved&&saved.value==="saved";
      if(saved&&!confirm("Charge "+money(due+tip)+" to your "+SAVED+"?"))return;
      var keep=document.getElementById("saveCard"); keep=!!(keep&&keep.checked&&!saved);
      btn.disabled=true; msg.textContent="Processing…";
      (saved?Promise.resolve(null):(cardObj?cardObj.tokenize():Promise.reject(new Error("The card form didn't load. Refresh the page and try again.")))).then(function(r){
        if(r&&r.status!=="OK") throw new Error((r.errors&&r.errors[0]&&r.errors[0].message)||"Check your card details.");
        return fetch("/api/pay/${t}",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({saved:saved,token:r?r.token:null,tip:tip,save:keep})});
      }).then(function(res){return res.json().then(function(j){return {ok:res.ok,j:j};});}).then(function(x){
        if(!x.ok) throw new Error(x.j.error||"Payment didn't go through.");
        document.querySelector(".w").innerHTML='<div class="ok">✓</div><h1>'+(tipMode?"Thank you!":"Paid. Thank you!")+'</h1><p class="sub">'+x.j.message+'</p><p><a class="btn g" href="/">Back to Apex Detailing</a></p>';
      }).catch(function(e){btn.disabled=false;msg.textContent=e.message;});
    });
  })();
  </script>`));
}

export async function payApi(req, env, url) {
  const t = url.pathname.split("/")[3] || "";
  const b = /^[a-f0-9]{36}$/.test(t) ? await env.DB.prepare("SELECT * FROM bookings WHERE pay_token = ?").bind(t).first() : null;
  if (!b) return json({ error: "Link not found." }, 404);
  if (b.status !== "confirmed" && !b.paid_at) return json({ error: "This job was cancelled, so there's nothing to pay." }, 409);
  let body; try { body = await req.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "Bad request" }, 400);
  const tipMode = !!b.paid_at, tip = Math.max(0, Math.round(+body.tip || 0)), cap = tipLimit(bill(b).sub);
  if (tip > cap) return json({ error: "For a tip over " + money(cap) + ", text us at (732) 206-7084. Thank you!" }, 400);
  if (tipMode && (b.tip_cents || !tip)) return json({ error: b.tip_cents ? "Tip already received. Thank you!" : "Pick a tip amount." }, 400);
  const c = await customerFor(env, b), saved = c && c.card ? JSON.parse(c.card) : null;
  if (!(body.saved && saved) && !body.token) return json({ error: "Enter your card." }, 400);
  if (!(await claimBill(env, b.id, tipMode))) return json({ error: tipMode ? "Your tip is already going through. Thank you!" : "A payment for this job is already going through or done. Refresh this page in a minute." }, 409);
  let source, charged = false;   // once a card is charged, keep the claim even if saving the result fails (no second charge)
  try {
    if (body.saved && saved) source = saved.id;
    else if (body.token && c && body.save === true) source = (await saveCard(env, c, String(body.token))).id;   // only when they ticked "Save this card" (audit IA-006)
    else if (body.token) source = String(body.token);                                                            // otherwise charge it once, don't keep it
    else throw new Error("Enter your card.");
    const cardNow = c && c.card ? JSON.parse(c.card) : null, sqCust = c ? await ensureSquareCustomer(env, c) : null;
    if (tipMode) {
      const p = await charge(env, { source, amount: tip, customerId: sqCust, reference: b.id, note: "Tip · " + b.id, email: b.email, idem: "tip-" + b.id + "-" + tip }); charged = true;
      await env.DB.prepare("UPDATE bookings SET tip_cents = ?, tip_payment_id = ?" + (await clearClaim(env)) + " WHERE id = ?").bind(tip, p.id, b.id).run();
      await emailReceipt(env, b, { tipOnly: true, tip, method: (p.brand || "Card") + " ending " + (p.last4 || ""), receipt: p.receipt }).catch(() => {});
      return json({ ok: true, message: "We got your " + money(tip) + " tip. It really means a lot." });
    }
    const B = bill(b), due = B.total;
    const p = await charge(env, { source, amount: due + tip, customerId: sqCust, reference: b.id, note: "Apex Detailing " + NAMES[b.pkg] + " · " + b.id + " · " + money(B.sub) + " + " + money(B.tax) + " " + TAX.name + (tip ? " + " + money(tip) + " tip" : ""), email: b.email, idem: "pay-" + b.id + "-" + (due + tip) }); charged = true;
    await env.DB.prepare("UPDATE bookings SET paid_at = ?, paid_method = 'online', payment_id = ?, receipt_url = ?, final_cents = ?, tax_cents = ?, tip_cents = ?, completed_at = COALESCE(completed_at, ?)" + (await clearClaim(env)) + " WHERE id = ?")
      .bind(Date.now(), p.id, p.receipt, B.sub, B.tax, tip, Date.now(), b.id).run();
    await emailReceipt(env, Object.assign(b, { tip_cents: tip }), { amount: B.sub, tax: B.tax, tip, method: (p.brand || "Card") + " ending " + (p.last4 || ""), receipt: p.receipt, offerTip: false }).catch(() => {});
    return json({ ok: true, message: "We emailed your receipt to " + b.email + "." });
  } catch (e) { if (!charged) await releaseBill(env, b.id); return json({ error: charged ? "Your payment went through, but we couldn't save it. Please text us at (732) 206-7084 so we can send your receipt." : e.message }, charged ? 500 : 402); }
}

// ---------- saving a card from the booking form or the account page ----------
export async function saveCardFor(env, customer, token, postal) { return saveCard(env, customer, token, postal); }
