// Before/after job photos: the checklist (angles), uploads to R2, damage pins, the customer's gallery and the
// "your photos are ready" email. Files live in the R2 bucket bound as PHOTOS; D1 keeps the index (photos, job_angles).
// Nothing is ever deleted right away: a retake or a delete keeps the old files for 30 days (purgeTrash, hourly cron).
import { send, layout, hero, para, note, buttons, h } from "./email.js";

export const storageOn = env => !!(env.PHOTOS && typeof env.PHOTOS.put === "function");
const json = (d, s) => new Response(JSON.stringify(d), { status: s || 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), x => x.toString(16).padStart(2, "0")).join("");
const ID_RE = /^[a-f0-9-]{16,40}$/i;
const STORAGE_OFF = "Photo storage isn't turned on yet (Cloudflare R2). Photos stay saved on this phone and upload once it's on.";

// the checklist each package starts with (exterior walk-around first, then inside)
export const ANGLES = {
  exterior: ["Front 3/4 Driver", "Driver Side", "Rear 3/4 Passenger", "Passenger Side", "Front", "Rear", "Wheels"],
  interior: ["Dash", "Front Seats", "Rear Seats", "Cargo"]
};
export function defaultAngles(b) {
  const list = b.pkg === "exterior" ? ANGLES.exterior.slice() : b.pkg === "interior" ? ANGLES.interior.slice() : ANGLES.exterior.concat(ANGLES.interior);
  const adds = JSON.parse(b.adds || "[]");
  if (adds.includes("engine")) list.push("Engine Bay");
  if (adds.includes("lights")) list.push("Headlights");
  return list;
}

// the job's angles (made from the package the first time; ids are fixed so two phones opening it at once agree)
export async function anglesFor(env, b) {
  let r = (await env.DB.prepare("SELECT * FROM job_angles WHERE booking_id = ? ORDER BY sort, created_at").bind(b.id).all()).results || [];
  if (!r.length) {
    const now = Date.now();
    await env.DB.batch(defaultAngles(b).map((n, i) => env.DB.prepare("INSERT OR IGNORE INTO job_angles (id, booking_id, name, sort, custom, pins, created_at) VALUES (?, ?, ?, ?, 0, '[]', ?)").bind(b.id + "-a" + i, b.id, n, i * 10, now)));
    r = (await env.DB.prepare("SELECT * FROM job_angles WHERE booking_id = ? ORDER BY sort, created_at").bind(b.id).all()).results || [];
  }
  return r;
}

const photoOut = p => p ? { id: p.id, w: p.w, h: p.h, taken: p.taken_at, hidden: !!p.hidden, meta: p.meta ? JSON.parse(p.meta) : null } : null;
// everything the job screen needs about photos
export async function photoState(env, b) {
  const angles = await anglesFor(env, b);
  const ph = (await env.DB.prepare("SELECT * FROM photos WHERE booking_id = ? AND deleted_at IS NULL AND replaced_at IS NULL ORDER BY taken_at").bind(b.id).all()).results || [];
  const cur = {}; for (const p of ph) cur[p.angle_id + ":" + p.phase] = p;   // newest wins
  const list = angles.filter(a => !a.removed_at).map(a => ({ id: a.id, name: a.name, custom: !!a.custom, pins: JSON.parse(a.pins || "[]"), notes: a.notes || "",
    before: photoOut(cur[a.id + ":before"]), after: photoOut(cur[a.id + ":after"]) }));
  const removed = angles.filter(a => a.removed_at).map(a => ({ id: a.id, name: a.name }));
  return { storage: storageOn(env), angles: list, removed, counts: { before: list.filter(a => a.before).length, after: list.filter(a => a.after).length, total: list.length },
    sentAt: b.photos_sent_at || null, share: { ok: b.share_ok == null ? null : !!b.share_ok, at: b.share_at || null, by: b.share_by || null } };
}

// change one angle: { name } rename, { pins, notes } damage, { remove: true } / { restore: true }
export async function setAngle(env, b, aid, body) {
  const a = await env.DB.prepare("SELECT * FROM job_angles WHERE id = ? AND booking_id = ?").bind(aid, b.id).first();
  if (!a) throw new Error("That angle isn't on this job.");
  if (body.remove) { await env.DB.prepare("UPDATE job_angles SET removed_at = ? WHERE id = ?").bind(Date.now(), aid).run(); return; }
  if (body.restore) { await env.DB.prepare("UPDATE job_angles SET removed_at = NULL WHERE id = ?").bind(aid).run(); return; }
  const f = {};
  if (typeof body.name === "string") { const n = body.name.trim().slice(0, 40); if (!n) throw new Error("Give the angle a name."); f.name = n; }
  if (Array.isArray(body.pins)) f.pins = JSON.stringify(body.pins.slice(0, 40).map(p => ({ x: Math.max(0, Math.min(1, +p.x || 0)), y: Math.max(0, Math.min(1, +p.y || 0)),
    label: String(p.label || "").trim().slice(0, 30) || "Damage", note: String(p.note || "").trim().slice(0, 200) })));
  if (typeof body.notes === "string") f.notes = body.notes.trim().slice(0, 1000);
  const k = Object.keys(f); if (!k.length) return;
  await env.DB.prepare("UPDATE job_angles SET " + k.map(x => x + " = ?").join(", ") + " WHERE id = ?").bind(...k.map(x => f[x]), aid).run();
}
export async function addAngle(env, b, name) {
  const n = String(name || "").trim().slice(0, 40); if (!n) throw new Error("Give the angle a name, like Engine Bay.");
  const list = await anglesFor(env, b), max = list.reduce((m, a) => Math.max(m, a.sort), 0), id = rid();
  await env.DB.prepare("INSERT INTO job_angles (id, booking_id, name, sort, custom, pins, created_at) VALUES (?, ?, ?, ?, 1, '[]', ?)").bind(id, b.id, n, max + 10, Date.now()).run();
  return id;
}

// ---------- upload (multipart: meta JSON + full JPEG + thumbnail JPEG) ----------
const isJpeg = buf => { const u = new Uint8Array(buf, 0, 3); return u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff; };
export async function uploadPhoto(req, env) {
  if (!storageOn(env)) return json({ error: STORAGE_OFF, storageOff: true }, 503);
  let fd; try { fd = await req.formData(); } catch (e) { return json({ error: "Bad upload." }, 400); }
  let meta; try { meta = JSON.parse(String(fd.get("meta") || "")); } catch (e) { return json({ error: "Bad upload." }, 400); }
  const full = fd.get("full"), thumb = fd.get("thumb");
  if (!meta || !ID_RE.test(String(meta.id || "")) || !["before", "after"].includes(meta.phase) || !full || !thumb || typeof full.arrayBuffer !== "function" || typeof thumb.arrayBuffer !== "function") return json({ error: "That upload was incomplete.", gone: true }, 400);
  const b = await env.DB.prepare("SELECT * FROM bookings WHERE id = ?").bind(String(meta.booking || "")).first();
  if (!b) return json({ error: "That job doesn't exist anymore.", gone: true }, 404);
  const a = await env.DB.prepare("SELECT * FROM job_angles WHERE id = ? AND booking_id = ?").bind(String(meta.angle || ""), b.id).first();
  if (!a) return json({ error: "That angle isn't on this job anymore.", gone: true }, 404);
  const have = await env.DB.prepare("SELECT id FROM photos WHERE id = ?").bind(meta.id).first();
  if (have) return json({ ok: true, id: meta.id, repeat: true });   // already here (a retry after a lost answer)
  const fb = await full.arrayBuffer(), tb = await thumb.arrayBuffer();
  if (fb.byteLength > 15e6 || tb.byteLength > 1.5e6 || fb.byteLength < 1000 || !isJpeg(fb) || !isJpeg(tb)) return json({ error: "That photo file isn't right (JPEG under 15 MB).", gone: true }, 400);
  const key = "jobs/" + b.id + "/" + meta.id + ".jpg", tkey = "jobs/" + b.id + "/" + meta.id + "_t.jpg", hm = { contentType: "image/jpeg" };
  await env.PHOTOS.put(key, fb, { httpMetadata: hm });
  await env.PHOTOS.put(tkey, tb, { httpMetadata: hm });
  const now = Date.now(), taken = Number.isFinite(+meta.taken) && +meta.taken > 1.6e12 && +meta.taken < now + 864e5 ? Math.round(+meta.taken) : now;
  const extra = JSON.stringify({ lens: String(meta.lens || "").slice(0, 40) || null, zoom: Number.isFinite(+meta.zoom) ? Math.round(+meta.zoom * 100) / 100 : null, source: String(meta.source || "").slice(0, 20) || null });
  // the newest shot for an angle is the current one; a retake replaces the older one only now that the new one is safely saved
  const newer = await env.DB.prepare("SELECT id FROM photos WHERE booking_id = ? AND angle_id = ? AND phase = ? AND deleted_at IS NULL AND replaced_at IS NULL AND taken_at > ? LIMIT 1").bind(b.id, a.id, meta.phase, taken).first();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO photos (id, booking_id, angle_id, phase, r2_key, thumb_key, w, h, bytes, taken_at, meta, replaced_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(meta.id, b.id, a.id, meta.phase, key, tkey, Math.round(+meta.w) || null, Math.round(+meta.h) || null, fb.byteLength, taken, extra, newer ? now : null, now),
    newer ? null : env.DB.prepare("UPDATE photos SET replaced_at = ? WHERE booking_id = ? AND angle_id = ? AND phase = ? AND id != ? AND deleted_at IS NULL AND replaced_at IS NULL").bind(now, b.id, a.id, meta.phase, meta.id),
    env.DB.prepare("UPDATE bookings SET started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'confirmed'").bind(now, b.id)   // the walk-around started: In progress
  ].filter(Boolean));
  return json({ ok: true, id: meta.id });
}

// the image itself (owner, or the customer's gallery once photos are sent)
export async function photoFile(env, p, thumb, download) {
  if (!storageOn(env)) return new Response("Photo storage is off", { status: 503 });
  const o = await env.PHOTOS.get(thumb ? p.thumb_key : p.r2_key);
  if (!o) return new Response("Not found", { status: 404 });
  const hd = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
  if (download) hd["Content-Disposition"] = 'attachment; filename="' + download.replace(/[^\w .&()-]/g, "") + '"';
  return new Response(o.body, { headers: hd });
}

export async function hidePhoto(env, id, hidden) { await env.DB.prepare("UPDATE photos SET hidden = ? WHERE id = ?").bind(hidden ? 1 : 0, id).run(); }
export async function deletePhoto(env, id) { await env.DB.prepare("UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(Date.now(), id).run(); }
export async function deleteJobPhotos(env, bookingId) {
  await env.DB.batch([env.DB.prepare("UPDATE photos SET deleted_at = ? WHERE booking_id = ? AND deleted_at IS NULL").bind(Date.now(), bookingId),
    env.DB.prepare("DELETE FROM job_angles WHERE booking_id = ?").bind(bookingId)]);
}

// hourly: remove the files of photos that were replaced or deleted more than 30 days ago
export async function purgeTrash(env) {
  if (!storageOn(env)) return 0;
  const cut = Date.now() - 30 * 864e5;
  const r = (await env.DB.prepare("SELECT id, r2_key, thumb_key FROM photos WHERE purged_at IS NULL AND ((deleted_at IS NOT NULL AND deleted_at < ?) OR (replaced_at IS NOT NULL AND replaced_at < ?)) LIMIT 50").bind(cut, cut).all()).results || [];
  for (const p of r) { await env.PHOTOS.delete([p.r2_key, p.thumb_key]).catch(() => {}); await env.DB.prepare("UPDATE photos SET purged_at = ? WHERE id = ?").bind(Date.now(), p.id).run(); }
  return r.length;
}

// ---------- the customer's side ----------
async function sentPairs(env, b) {
  const st = await photoState(env, b);
  return st.angles.map(a => ({ name: a.name, before: a.before && !a.before.hidden ? a.before : null, after: a.after && !a.after.hidden ? a.after : null })).filter(a => a.after);   // the gallery shows finished results (before-only angles stay in Nick's records)
}
export async function sendPhotosEmail(env, b, H) {
  const pairs = await sentPairs(env, b);
  if (!pairs.some(p => p.after)) throw new Error("Take at least one After photo first.");
  await env.DB.prepare("UPDATE bookings SET photos_sent_at = ? WHERE id = ?").bind(Date.now(), b.id).run();
  b.photos_sent_at = Date.now();
  if (!b.email || /\.invalid$/i.test(b.email)) return { sent: false, link: env.SITE_URL + "/b/" + b.token + "/photos" };
  const site = env.SITE_URL, link = site + "/b/" + b.token + "/photos", first = (b.name || "").split(" ")[0] || "there";
  const best = pairs.find(p => p.before && p.after) || pairs[0], img = id => site + "/b/" + b.token + "/p/" + id + "?t=1";
  const cell = (p, lbl) => p ? `<td width="50%" style="padding:0 4px;vertical-align:top"><img src="${h(img(p.id))}" width="100%" alt="${lbl}" style="display:block;width:100%;height:auto;border-radius:10px;border:0"><p style="margin:6px 0 0;font-size:11px;font-weight:700;letter-spacing:.14em;color:#9a9a9a">${lbl}</p></td>` : "";
  const pic = best && best.before && best.after ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${cell(best.before, "BEFORE")}${cell(best.after, "AFTER")}</tr></table>` : "";
  const subject = "Your before & after photos are ready";
  const body = hero("Your photos", `Here's the difference, ${h(first)}.`, `We took before and after photos of your ${h(H.pkgName(b))}${b.car ? " on your " + h(b.car) : ""}. They're all in one place, ready to save.`) +
    pic + buttons([[link, "See all your photos"]]) +
    para("Love how it came out? We'd be grateful if we could feature your car on our Instagram. You can say yes or no on the photo page. We always hide plates and anything that shows your address.") +
    note("The photos also protect you: they show your car's condition before and after the detail.");
  await send(env, { to: b.email, subject, html: layout(subject, body, "Your before and after photos are ready to see and save.", site) });
  return { sent: true, link };
}

// /b/<token>/photos (gallery), /b/<token>/p/<photoId> (image), POST /b/<token>/share (OK to post)
export async function galleryRoute(req, env, url, b, sub, H) {
  if (sub === "share" && req.method === "POST") {
    const o = req.headers.get("Origin"); if (o && o !== url.origin) return new Response("Not allowed", { status: 403 });
    const fd = await req.formData().catch(() => null), v = fd && fd.get("ok");
    if (v === "1" || v === "0") await env.DB.prepare("UPDATE bookings SET share_ok = ?, share_at = ?, share_by = 'customer' WHERE id = ?").bind(+v, Date.now(), b.id).run();
    return new Response(null, { status: 303, headers: { Location: "/b/" + b.token + "/photos?saved=1#share", "Cache-Control": "no-store" } });
  }
  const pm = sub && sub.match(/^p\/([a-f0-9-]{16,40})$/i);
  if (pm) {
    if (!b.photos_sent_at) return new Response("Not found", { status: 404 });
    const p = await env.DB.prepare("SELECT p.*, a.name angle FROM photos p JOIN job_angles a ON a.id = p.angle_id AND a.removed_at IS NULL WHERE p.id = ? AND p.booking_id = ? AND p.deleted_at IS NULL AND p.replaced_at IS NULL AND p.hidden = 0").bind(pm[1], b.id).first();
    if (!p) return new Response("Not found", { status: 404 });
    const dl = url.searchParams.get("dl") === "1" ? "Apex Detailing - " + (p.angle || "Photo") + " - " + (p.phase === "before" ? "Before" : "After") + ".jpg" : null;
    return photoFile(env, p, url.searchParams.get("t") === "1", dl);
  }
  if (sub !== "photos") return null;
  const head = `<h1>Your before &amp; after photos</h1><p class="sub">${h(H.pkgName(b))}${b.car ? " · " + h(b.car) : ""} · ${h(H.whenText(b))}</p>`;
  if (!b.photos_sent_at || !storageOn(env)) return H.html(H.page("Your photos", head + `<p class="note">Your photos aren't ready yet. We'll email you as soon as they are.</p>`));
  const pairs = await sentPairs(env, b), src = (p, t) => "/b/" + b.token + "/p/" + p.id + (t ? "?t=1" : ""), saved = url.searchParams.get("saved") === "1";
  const card = a => {
    const both = a.before && a.after;
    const view = both ? `<div class="cmp" style="position:relative;border-radius:16px;overflow:hidden;aspect-ratio:${a.after.w && a.after.h ? a.after.w + "/" + a.after.h : "4/3"};background:#111;touch-action:pan-y">
        <img src="${src(a.before)}" alt="${h(a.name)} before" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">
        <div class="aft" style="position:absolute;inset:0;clip-path:inset(0 0 0 50%)"><img src="${src(a.after)}" alt="${h(a.name)} after" loading="lazy" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>
        <div class="bar" style="position:absolute;top:0;bottom:0;left:50%;width:2px;background:#fff;box-shadow:0 0 8px rgba(0,0,0,.6)"><span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:34px;height:34px;border-radius:50%;background:#fff;color:#000;display:grid;place-items:center;font-size:14px;font-weight:700">⇆</span></div>
        <span style="position:absolute;left:10px;top:10px;font-size:11px;font-weight:700;letter-spacing:.14em;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:999px">BEFORE</span>
        <span style="position:absolute;right:10px;top:10px;font-size:11px;font-weight:700;letter-spacing:.14em;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:999px">AFTER</span></div>`
      : `<img src="${src(a.before || a.after)}" alt="${h(a.name)}" loading="lazy" style="display:block;width:100%;border-radius:16px">`;
    const dl = [a.before ? `<a class="btn g" style="min-height:40px;font-size:14px" href="${src(a.before)}?dl=1">Save before</a>` : "", a.after ? `<a class="btn g" style="min-height:40px;font-size:14px" href="${src(a.after)}?dl=1">Save after</a>` : ""].join("").replace(/\?t=1\?dl=1/g, "?dl=1");
    return `<div style="margin-top:22px"><b style="display:block;margin-bottom:8px">${h(a.name)}</b>${view}<div style="display:flex;gap:8px;margin-top:10px">${dl}</div></div>`;
  };
  const share = b.share_ok == null ? `<form method="post" action="/b/${b.token}/share" style="display:flex;gap:8px;margin-top:12px"><button class="btn" name="ok" value="1" style="flex:1">Yes, feature my car</button><button class="btn g" name="ok" value="0" style="flex:1">No thanks</button></form>`
    : `<p class="note" style="margin-top:10px">${saved ? "Thanks! " : ""}You said <b style="color:#ededed">${b.share_ok ? "yes" : "no"}</b>. <form method="post" action="/b/${b.token}/share" style="display:inline"><button class="lnk" name="ok" value="${b.share_ok ? 0 : 1}" style="border:0;background:none;color:#ededed;text-decoration:underline;font:inherit;cursor:pointer;padding:0">Change to ${b.share_ok ? "no" : "yes"}</button></form></p>`;
  const js = `<script>[].forEach.call(document.querySelectorAll(".cmp"),function(c){var a=c.querySelector(".aft"),bar=c.querySelector(".bar");function set(x){var r=c.getBoundingClientRect(),p=Math.max(0,Math.min(100,(x-r.left)/r.width*100));a.style.clipPath="inset(0 0 0 "+p+"%)";bar.style.left=p+"%";}
    var on=false;c.addEventListener("pointerdown",function(e){on=true;c.setPointerCapture(e.pointerId);set(e.clientX);});c.addEventListener("pointermove",function(e){if(on)set(e.clientX);});c.addEventListener("pointerup",function(){on=false;});c.addEventListener("pointercancel",function(){on=false;});});</script>`;
  return H.html(H.page("Your photos", head + `<p class="note">Drag across a photo to compare before and after. Tap Save to keep a full-size copy.</p>` + pairs.map(card).join("") +
    `<h2 id="share">Can we feature your car?</h2><p class="note">We'd love to share your before and after on our website and Instagram. We always hide plates and anything that shows your address.</p>${share}` + js));
}
