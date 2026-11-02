// Emails go out through Resend (API key in the RESEND_API_KEY secret). Replies go to contact@apexdetailingoc.com.
// Design (Nov 2): the same look as the website. Black page, a dark card, the white peak logo, big white
// headline, quiet gray text, a dark "details" panel and white pill buttons. Everything is tables + inline
// styles so it holds up in Gmail, Apple Mail and Outlook; every email also gets a plain-text version.

export async function send(env, msg) {
  if (msg.html && !msg.text) msg.text = toText(msg.html);
  if (env.__capture) { env.__capture.push(msg); return { captured: true }; }   // dev preview (/__dev/emails): build, don't send
  if (!env.RESEND_API_KEY) { console.log("email skipped (no RESEND_API_KEY):", msg.subject, "->", msg.to); return { skipped: true }; }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ from: env.FROM_EMAIL, reply_to: env.NICK_EMAIL }, msg))
  });
  if (!r.ok) { const t = await r.text(); console.log("email failed", r.status, t); return { error: t }; }
  return r.json();
}

export const h = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- design tokens ----------
const C = { page: "#000000", card: "#0b0b0b", panel: "#151515", line: "#262626", line2: "#1e1e1e", fg: "#f5f5f5", text: "#c4c4c4", muted: "#9a9a9a", faint: "#707070", warn: "#ff8a80" };
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// ---------- layout ----------
// title: <title>; body: inner HTML; preheader: the gray preview line in the inbox; site: SITE_URL (for images + links)
// opts.who: "customer" (default) or "nick" (shorter footer)
export function layout(title, body, preheader, site, opts) {
  opts = opts || {};
  // the header logo is /email-logo.png: that one file is public on the test site too (a Cloudflare Access bypass), so it always loads
  const logo = site + "/email-logo.png";
  const foot = opts.who === "nick"
    ? `<p style="margin:0;font-size:12px;line-height:1.6;color:${C.faint}">Sent to you by the Apex booking system. Reply to reach the customer.</p>`
    : `<p style="margin:0 0 10px;font-size:13px;line-height:1.6;color:${C.muted}">Questions? Just reply to this email.</p>
       <p style="margin:0 0 14px;font-size:13px;line-height:1.6"><a href="${h(site)}" style="color:${C.fg};text-decoration:none;font-weight:600">apexdetailingoc.com</a><span style="color:${C.faint}">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="https://www.instagram.com/apexdetailingoc" style="color:${C.fg};text-decoration:none;font-weight:600">Instagram</a><span style="color:${C.faint}">&nbsp;&nbsp;·&nbsp;&nbsp;</span><a href="https://www.tiktok.com/@apexdetailingoc" style="color:${C.fg};text-decoration:none;font-weight:600">TikTok</a></p>
       <p style="margin:0;font-size:12px;line-height:1.6;color:${C.faint}">Apex Detailing LLC · Mobile car detailing in Brick &amp; Ocean County, NJ<br>(732) 206-7084 · contact@apexdetailingoc.com</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${h(title)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;background:${C.page}}
a{color:${C.fg}}
@media (max-width:620px){
  .wrap{padding:12px 0 24px !important}
  .card{border-radius:0 !important;border-left:0 !important;border-right:0 !important}
  .pad{padding-left:22px !important;padding-right:22px !important}
  .h1{font-size:27px !important}
  .btn-cell{display:block !important;width:100% !important;padding:0 0 10px 0 !important}
  .btns{width:100% !important}
  .btn-cell table{width:100% !important}
  .btn-cell a{display:block !important;text-align:center !important}
  .lbl{width:40% !important}
}
</style></head>
<body style="margin:0;padding:0;background:${C.page};color:${C.fg};font-family:${FONT};-webkit-font-smoothing:antialiased" bgcolor="${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${h(preheader || "")}${"&nbsp;&zwnj;".repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}"><tr><td align="center" class="wrap" style="padding:28px 12px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card" bgcolor="${C.card}" style="max-width:600px;background:${C.card};border:1px solid ${C.line2};border-radius:26px;overflow:hidden">
<tr><td class="pad" bgcolor="${C.card}" style="padding:26px 34px 22px;background-color:${C.card};background-image:linear-gradient(${C.card},${C.card});border-bottom:1px solid ${C.line2}">
<a href="${h(site)}" style="text-decoration:none"><img src="${h(logo)}" width="190" height="19" alt="APEX DETAILING" style="display:block;border:0;width:190px;height:19px;color:${C.fg};font-family:${FONT};font-size:14px;font-weight:700;letter-spacing:.2em"></a>
</td></tr>
<tr><td class="pad" style="padding:34px 34px 10px;font-family:${FONT}">${body}</td></tr>
<tr><td class="pad" style="padding:26px 34px 32px;border-top:1px solid ${C.line2};font-family:${FONT}">
${foot}
</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ---------- building blocks ----------
// small letter-spaced label above the headline, the big headline, and an intro paragraph
export function hero(kicker, title, text) {
  return (kicker ? `<p style="margin:0 0 12px;font-size:12px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:${C.muted}">${kicker}</p>` : "") +
    `<h1 class="h1" style="margin:0 0 14px;font-size:31px;line-height:1.15;font-weight:700;letter-spacing:-.02em;color:${C.fg}">${title}</h1>` +
    (text ? `<p style="margin:0 0 26px;font-size:16px;line-height:1.6;color:${C.text}">${text}</p>` : `<div style="height:12px;line-height:12px">&nbsp;</div>`);
}
export function para(html, opts) {
  opts = opts || {};
  return `<p style="margin:0 0 ${opts.mb != null ? opts.mb : 18}px;font-size:${opts.size || 15}px;line-height:1.6;color:${opts.color || C.text}">${html}</p>`;
}
export function note(html) { return `<p style="margin:0 0 18px;font-size:13px;line-height:1.6;color:${C.muted}">${html}</p>`; }
export function heading(text) { return `<p style="margin:8px 0 10px;font-size:12px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${C.muted}">${text}</p>`; }

// the date/time of a booking, shown big (like a ticket)
export function when(dayText, timeText, sub) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;background:${C.panel};border:1px solid ${C.line};border-radius:20px"><tr><td style="padding:20px 22px">
<p style="margin:0 0 4px;font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-.01em;color:${C.fg}">${h(dayText)}</p>
<p style="margin:0;font-size:16px;line-height:1.5;color:${C.text}">${h(timeText)}</p>${sub ? `<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:${C.muted}">${sub}</p>` : ""}
</td></tr></table>`;
}

// label/value rows in a dark panel. A row is [label, value, isHtml?, "total"?]; empty values are skipped.
export function rows(list) {
  const R = list.filter(r => r && r[1] != null && r[1] !== "");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 26px;background:${C.panel};border:1px solid ${C.line};border-radius:20px;border-collapse:separate"><tr><td style="padding:6px 22px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">` +
    R.map((r, i) => {
      const tot = r[3] === "total", top = i === 0 ? "0" : `1px solid ${tot ? C.line : C.line2}`;
      return `<tr><td class="lbl" valign="top" style="padding:13px 12px 13px 0;border-top:${top};width:36%;font-size:13px;line-height:1.45;color:${tot ? C.fg : C.muted};font-weight:${tot ? 700 : 500}">${r[0] && r[0].html ? r[0].html : h(r[0])}</td>` +
        `<td valign="top" style="padding:13px 0;border-top:${top};font-size:${tot ? 17 : 15}px;line-height:1.45;color:${C.fg};font-weight:${tot ? 700 : 600}">${r[2] ? r[1] : h(r[1])}</td></tr>`;
    }).join("") + `</table></td></tr></table>`;
}

// a quieter second line inside a row value
export const sub = t => `<br><span style="font-size:13px;font-weight:500;color:${C.muted}">${t}</span>`;

// pill buttons. kind: "primary" (white) or "secondary" (outlined)
export function button(href, label, kind, small) {
  const pri = kind !== "secondary" && kind !== false;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate"><tr><td align="center" bgcolor="${pri ? C.fg : C.card}" style="border-radius:999px;background:${pri ? C.fg : C.card};${pri ? "" : "border:1px solid #3a3a3a;"}">` +
    `<a href="${h(href)}" style="display:inline-block;padding:${small ? "11px 18px" : "15px 28px"};font-family:${FONT};font-size:15px;font-weight:700;line-height:1;color:${pri ? "#000000" : C.fg};text-decoration:none;border-radius:999px;white-space:nowrap">${h(label)}</a></td></tr></table>`;
}
// one or two buttons in a row (they stack full-width on phones). opts.inline: small buttons that stay in a row (quick actions)
export function buttons(list, opts) {
  const L = list.filter(Boolean), inl = opts && opts.inline;
  return `<table role="presentation"${inl ? "" : ` class="btns"`} cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${inl ? 18 : 26}px"><tr>` +
    L.map((b, i) => `<td${inl ? "" : ` class="btn-cell"`} style="padding:0 ${i < L.length - 1 ? (inl ? 8 : 10) : 0}px 0 0">${button(b[0], b[1], b[2], inl)}</td>`).join("") + `</tr></table>`;
}

// a short list with check marks (e.g. "Before we arrive")
export function checklist(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px">` +
    items.map(t => `<tr><td valign="top" style="width:28px;padding:0 0 12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" style="width:20px;height:20px;border-radius:999px;background:${C.fg};color:#000000;font-size:12px;font-weight:700;line-height:20px">&#10003;</td></tr></table></td>` +
      `<td valign="top" style="padding:1px 0 12px;font-size:15px;line-height:1.5;color:${C.text}">${t}</td></tr>`).join("") + `</table>`;
}

// the big sign-in code
export function codeBox(code) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background:${C.panel};border:1px solid ${C.line};border-radius:20px"><tr><td align="center" style="padding:26px 12px">
<p style="margin:0;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:40px;line-height:1;font-weight:700;letter-spacing:.24em;color:${C.fg}">${h(code)}</p></td></tr></table>`;
}

// "APEX MEMBERSHIP" with the peak, for use inside text (always shown with the logo)
export function am(site) {
  return `<span style="white-space:nowrap;font-size:.82em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.fg}"><img src="${h(site)}/email/apex-mark-white-56.png" width="14" height="10" alt="" style="display:inline-block;border:0;width:14px;height:10px;margin:0 5px 0 0;vertical-align:0">Apex Membership</span>`;
}

// a soft warning box (e.g. "check the address")
export function alertBox(html) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;background:#1f1414;border:1px solid #4a2626;border-radius:16px"><tr><td style="padding:14px 18px;font-size:14px;line-height:1.55;color:${C.warn}">${html}</td></tr></table>`;
}

// ---------- plain-text version (good for deliverability and old mail apps) ----------
export function toText(html) {
  let s = String(html);
  s = s.replace(/<head[\s\S]*?<\/head>/i, "").replace(/<div style="display:none[\s\S]*?<\/div>/i, "");
  s = s.replace(/<img[^>]*>/gi, "");
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => { const t = label.replace(/<[^>]+>/g, "").trim(); const u = href.replace(/&amp;/g, "&"); return !t ? "" : /^(mailto|tel|sms):/.test(u) || t === u || u.replace(/^https?:\/\//, "").replace(/\/$/, "") === t ? t : t + " (" + u + ")"; });
  s = s.replace(/<td class="lbl"[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi, (m, a, b) => a.replace(/<[^>]+>/g, "").trim() + ": " + b + "\n");
  s = s.replace(/<table[^>]*><tr><td[^>]*>&#10003;<\/td><\/tr><\/table>\s*<\/td>\s*<td[^>]*>/gi, "- ");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|h1|h2|tr|table)>/gi, "\n\n").replace(/&#10003;/g, "-");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&zwnj;/g, "").replace(/&middot;/g, "·").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  s = s.split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}
