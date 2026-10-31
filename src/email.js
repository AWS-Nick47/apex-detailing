// Emails go out through Resend (API key in the RESEND_API_KEY secret). Replies go to contact@apexdetailingoc.com.

export async function send(env, msg) {
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

// One simple, email-safe layout (tables + inline styles so it looks right in Gmail and Apple Mail)
export function layout(title, bodyHtml, preheader, logoUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${h(title)}</title></head>
<body style="margin:0;padding:0;background:#f2f2f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${h(preheader || "")}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden">
<tr><td style="background:#0b0b0b;padding:20px 28px;color:#fff;font-size:15px;font-weight:700;letter-spacing:.18em">${logoUrl ? `<img src="${h(logoUrl)}" width="190" height="19" alt="APEX DETAILING" style="display:block;border:0;width:190px;height:19px;color:#fff;font-size:15px;font-weight:700;letter-spacing:.18em">` : "APEX DETAILING"}</td></tr>
<tr><td style="padding:28px">${bodyHtml}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #eee;color:#777;font-size:12px;line-height:1.5">Apex Detailing · Mobile detailing in Brick &amp; Ocean County, NJ<br>(732) 206-7084 · contact@apexdetailingoc.com · @apexdetailingoc</td></tr>
</table></td></tr></table></body></html>`;
}

export function rows(list) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;font-size:15px">` +
    list.filter(r => r && r[1] != null && r[1] !== "").map(r => `<tr><td style="padding:9px 0;border-bottom:1px solid #eee;color:#666;width:34%;vertical-align:top">${h(r[0])}</td><td style="padding:9px 0;border-bottom:1px solid #eee;font-weight:600;vertical-align:top">${r[2] ? r[1] : h(r[1])}</td></tr>`).join("") +
    `</table>`;
}

export function button(href, label, dark) {
  return `<a href="${h(href)}" style="display:inline-block;padding:13px 22px;border-radius:999px;text-decoration:none;font-weight:700;font-size:15px;${dark === false ? "background:#f0f0f0;color:#111" : "background:#111;color:#fff"}">${h(label)}</a>`;
}
