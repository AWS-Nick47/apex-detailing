// Square: save cards (Cards API) and take payments (Payments API).
// Card numbers never touch our server — the browser turns them into a one-time token with Square's card form.

export const squareOn = env => !!(env.SQUARE_ACCESS_TOKEN && env.SQUARE_APP_ID && env.SQUARE_LOCATION_ID);
const base = env => (env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");
const key = () => crypto.randomUUID();

async function sq(env, method, path, body) {
  if (env.SQUARE_MOCK === "1") return mock(path, body);
  const r = await fetch(base(env) + path, {
    method,
    headers: { Authorization: "Bearer " + env.SQUARE_ACCESS_TOKEN, "Content-Type": "application/json", "Square-Version": "2025-07-16" },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = (j.errors || [])[0] || {};
    const err = new Error(friendly(e) || ("Square error " + r.status));
    err.code = e.code; err.detail = e.detail; console.log("square error", path, r.status, JSON.stringify(j.errors || j).slice(0, 400));
    throw err;
  }
  return j;
}

function friendly(e) {
  const c = e.code || "";
  if (/CARD_DECLINED|GENERIC_DECLINE|INSUFFICIENT_FUNDS|CARD_DECLINED_VERIFICATION_REQUIRED/.test(c)) return "Your card was declined. Try another card.";
  if (/CVV|VERIFY_CVV/.test(c)) return "The security code (CVV) didn't match. Check it and try again.";
  if (/EXPIRATION|INVALID_EXPIRATION/.test(c)) return "The expiration date isn't right. Check it and try again.";
  if (/ADDRESS_VERIFICATION|POSTAL/.test(c)) return "The ZIP code didn't match the card. Check it and try again.";
  if (/INVALID_CARD|CARD_NOT_SUPPORTED|INVALID_ACCOUNT/.test(c)) return "That card can't be used. Try another card.";
  return e.detail ? "Payment problem: " + e.detail : null;
}

function e164(phone) { const d = String(phone || "").replace(/\D/g, ""); return d.length === 10 ? "+1" + d : d.length === 11 && d[0] === "1" ? "+" + d : undefined; }

export async function ensureSquareCustomer(env, c) {
  if (c.square_customer_id) return c.square_customer_id;
  const parts = (c.name || "").trim().split(/\s+/);
  const j = await sq(env, "POST", "/v2/customers", { idempotency_key: key(), given_name: parts[0] || undefined, family_name: parts.slice(1).join(" ") || undefined,
    email_address: c.email, reference_id: c.id });   // phone left off: Square rejects some valid-looking numbers, and we keep the phone ourselves
  const id = j.customer.id;
  await env.DB.prepare("UPDATE customers SET square_customer_id = ? WHERE id = ?").bind(id, c.id).run();
  c.square_customer_id = id;
  return id;
}

// Save a card from a one-time token; replaces the customer's saved card
export async function saveCard(env, c, token, postal) {
  const sqId = await ensureSquareCustomer(env, c);
  const j = await sq(env, "POST", "/v2/cards", { idempotency_key: key(), source_id: token, card: { customer_id: sqId, cardholder_name: c.name || undefined, billing_address: postal ? { postal_code: postal } : undefined, reference_id: c.id } });
  const card = { id: j.card.id, brand: brandName(j.card.card_brand), last4: j.card.last_4, exp: j.card.exp_month + "/" + String(j.card.exp_year).slice(-2) };
  const old = c.card ? JSON.parse(c.card) : null;
  await env.DB.prepare("UPDATE customers SET card = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(card), Date.now(), c.id).run();
  if (old && old.id && old.id !== card.id) await sq(env, "POST", "/v2/cards/" + old.id + "/disable").catch(() => {});
  c.card = JSON.stringify(card);
  return card;
}

export async function removeCard(env, c) {
  const old = c.card ? JSON.parse(c.card) : null;
  if (old && old.id) await sq(env, "POST", "/v2/cards/" + old.id + "/disable").catch(() => {});
  await env.DB.prepare("UPDATE customers SET card = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), c.id).run();
}

// Charge: source is a saved card id or a one-time token. amount in cents.
export async function charge(env, { source, amount, customerId, reference, note, email, idem }) {
  const j = await sq(env, "POST", "/v2/payments", { idempotency_key: idem || key(), source_id: source, amount_money: { amount, currency: "USD" }, customer_id: customerId || undefined,
    location_id: env.SQUARE_LOCATION_ID, reference_id: reference, note: (note || "").slice(0, 500), buyer_email_address: email || undefined, autocomplete: true });
  const p = j.payment;
  return { id: p.id, status: p.status, receipt: p.receipt_url || null, brand: p.card_details && p.card_details.card ? brandName(p.card_details.card.card_brand) : null, last4: p.card_details && p.card_details.card ? p.card_details.card.last_4 : null };
}

function brandName(b) { return ({ VISA: "Visa", MASTERCARD: "Mastercard", AMERICAN_EXPRESS: "Amex", DISCOVER: "Discover", DISCOVER_DINERS: "Diners", JCB: "JCB", CHINA_UNIONPAY: "UnionPay", SQUARE_GIFT_CARD: "Gift card" })[b] || "Card"; }

// Local testing without Square (SQUARE_MOCK=1)
function mock(path, body) {
  if (path === "/v2/customers") return { customer: { id: "MOCKCUST" + Math.random().toString(36).slice(2, 8) } };
  if (path === "/v2/cards") { if (/decline/.test(body.source_id)) { const e = new Error("Your card was declined. Try another card."); throw e; } return { card: { id: "ccof:mock" + Math.random().toString(36).slice(2, 8), card_brand: "VISA", last_4: "1111", exp_month: 12, exp_year: 2030 } }; }
  if (path === "/v2/payments" && /decline/.test(body.source_id)) throw new Error("Your card was declined.");
  if (path === "/v2/payments") return { payment: { id: "mockpay" + Math.random().toString(36).slice(2, 8), status: "COMPLETED", receipt_url: null, card_details: { card: { card_brand: "VISA", last_4: "1111" } } } };
  return {};
}
