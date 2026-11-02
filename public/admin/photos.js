/* Apex Owner: before/after photos (v2, Nov 2).
   - Photo checklist on the job screen (built from the package; custom angles; damage pin counts)
   - Guided walk-around + full-screen camera with the Before laid see-through over the live view for Afters,
     lens/zoom matching, grid, torch, 4:3 framing, upright or sideways; or the iPhone's own camera (full quality)
   - Damage pins, compare (slider / side by side), export (labels, pins, watermark, plate blur) + share
   - Every photo is saved on the phone first (IndexedDB) and uploaded in order; the phone copy is removed only after
     the server has it, so a weak signal or closing the app never loses a photo. */
(function () {
  "use strict";
  var A = window.ApexApp; if (!A) return;
  var esc = A.esc, fsRoot = document.getElementById("fsRoot");
  var LABELS = ["Scratch", "Swirl Marks", "Paint Chip", "Dent", "Curb Rash", "Crack", "Stain", "Tear"];
  var PREF = (function () { try { return JSON.parse(localStorage.getItem("apex-cam") || "{}"); } catch (e) { return {}; } })();
  function savePref() { try { localStorage.setItem("apex-cam", JSON.stringify(PREF)); } catch (e) {} }
  if (PREF.grid == null) PREF.grid = false; if (PREF.ghost == null) PREF.ghost = true; if (PREF.opacity == null) PREF.opacity = 0.4;
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>"; }
  var I = {
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>'), grid: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>'),
    ghost: svg('<rect x="3" y="6" width="13" height="11" rx="2"/><rect x="8" y="9" width="13" height="11" rx="2" stroke-dasharray="2 2"/>'), torch: svg('<path d="M9 2h6l-1 6h3l-7 14 1-9H8z"/>'),
    iphone: svg('<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>'), pin: svg('<path d="M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z"/><circle cx="12" cy="10" r="2"/>'),
    share: svg('<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'), blur: svg('<rect x="4" y="7" width="16" height="10" rx="2"/><path d="M8 10h2v2H8zM12 12h2v2h-2zM16 10h0"/>')
  };

  // ---------- local queue (IndexedDB) ----------
  var Q = [], PEND = {}, OFF = { storage: false }, running = false, retryT = null;
  function idb() { return new Promise(function (res, rej) { var r = indexedDB.open("apex-owner", 1); r.onupgradeneeded = function () { r.result.createObjectStore("queue", { keyPath: "id" }); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function tx(mode, fn) { return idb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction("queue", mode), st = t.objectStore("queue"), out = fn(st); t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error("Storage is full")); }; }); }); }
  function qLoad() { return tx("readonly", function (st) { return st.getAll(); }).then(function (all) { Q = (all || []).sort(function (a, b) { return a.taken - b.taken; }); Q.forEach(mark); pill(); }).catch(function () { pill(); }); }
  function mark(r) {
    if (!r.url) r.url = URL.createObjectURL(r.full);
    if (!r.turl) r.turl = URL.createObjectURL(r.thumb);
    var k = r.booking + "|" + r.angle + "|" + r.phase, cur = PEND[k]; if (!cur || cur.taken <= r.taken) PEND[k] = r;
  }
  function unmark(r) { var k = r.booking + "|" + r.angle + "|" + r.phase; if (PEND[k] === r) delete PEND[k]; Q.filter(function (x) { return x !== r && x.booking + "|" + x.angle + "|" + x.phase === k; }).forEach(mark); }
  function enqueue(rec) {
    mark(rec); Q.push(rec); pill();
    var keep = { id: rec.id, booking: rec.booking, angle: rec.angle, phase: rec.phase, taken: rec.taken, w: rec.w, h: rec.h, lens: rec.lens, zoom: rec.zoom, source: rec.source, full: rec.full, thumb: rec.thumb, tries: 0 };
    return tx("readwrite", function (st) { st.put(keep); }).catch(function (e) { A.toast("This phone is out of space for photos. Upload what's waiting, then free up space.", true); throw e; }).then(function () { pump(); });
  }
  function pendingCount() { return Q.length; }
  function pill() {
    var p = document.getElementById("qpill"); if (!p) return;
    var n = Q.length, failed = Q.filter(function (r) { return r.failed; }).length;
    if (!n) { p.hidden = true; return; }
    p.hidden = false; p.className = "qpill";
    p.textContent = failed ? failed + " photo" + (failed > 1 ? "s" : "") + " need you" : OFF.storage ? n + " saved on phone" : !navigator.onLine ? n + " waiting for signal" : "↑ Uploading " + n;
  }
  function pump() {
    if (running || !Q.length) return;
    if (!navigator.onLine) { pill(); return; }
    var r = Q.filter(function (x) { return !x.failed; })[0]; if (!r) { pill(); return; }
    running = true; pill();
    var fd = new FormData();
    fd.append("meta", JSON.stringify({ id: r.id, booking: r.booking, angle: r.angle, phase: r.phase, taken: r.taken, w: r.w, h: r.h, lens: r.lens, zoom: r.zoom, source: r.source }));
    fd.append("full", r.full, r.id + ".jpg"); fd.append("thumb", r.thumb, r.id + "_t.jpg");
    fetch("/api/admin/photos", { method: "POST", body: fd, credentials: "same-origin", redirect: "manual" }).then(function (res) {
      if (res.type === "opaqueredirect") throw { signin: true };
      return res.json().catch(function () { return {}; }).then(function (j) { return { s: res.status, j: j }; });
    }).then(function (x) {
      running = false;
      if (x.s === 200) {
        OFF.storage = false;
        Q = Q.filter(function (y) { return y !== r; }); unmark(r);
        tx("readwrite", function (st) { st.delete(r.id); }).catch(function () {});
        setTimeout(function () { URL.revokeObjectURL(r.url); URL.revokeObjectURL(r.turl); }, 60000);
        pill(); reloadSoon(r.booking); pump(); return;
      }
      if (x.s === 503 && x.j.storageOff) { OFF.storage = true; pill(); later(300000); return; }
      if (x.j && x.j.gone) { r.failed = x.j.error || "Couldn't upload"; pill(); pump(); return; }
      later(20000);
    }).catch(function () { running = false; pill(); later(20000); });
  }
  function later(ms) { clearTimeout(retryT); retryT = setTimeout(pump, ms); }
  var reloadT = null;
  function reloadSoon(booking) { var j = A.job && A.job(); if (!j || j.id !== booking) return; clearTimeout(reloadT); reloadT = setTimeout(function () { if (!fsRoot.innerHTML) A.reloadJob(); }, 1500); }
  window.addEventListener("online", function () { pill(); pump(); });
  window.addEventListener("offline", pill);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) pump(); });
  document.getElementById("qpill").addEventListener("click", queueSheet);
  function queueSheet() {
    var h = '<p class="sub" style="margin-top:-6px">Photos are saved on this phone first and upload in order. They\'re removed from the phone only after the server has them.</p>' +
      (OFF.storage ? '<p class="note warnc">Photo storage (Cloudflare R2) isn\'t turned on yet, so these wait here.</p>' : "") +
      '<div class="menu">' + Q.map(function (r) { return '<div class="row card" style="padding:8px 10px"><div class="jrow"><img class="thumb" src="' + r.turl + '" alt=""><div><b>' + esc(r.booking) + " · " + esc(r.phase) + '</b><div class="dim small">' + new Date(r.taken).toLocaleString() + (r.failed ? '<br><span class="badc">' + esc(r.failed) + "</span>" : "") + "</div></div></div>" + (r.failed ? '<button class="btn d sm" data-qdrop="' + esc(r.id) + '">Discard</button>' : "") + "</div>"; }).join("") + "</div>" +
      '<div class="acts"><button class="btn" data-qnow>Retry now</button></div>';
    A.openSheet("Photos on this phone", h, { close: "Done", guard: false });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // ---------- photo helpers ----------
  function uuid() { return (crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); })).toLowerCase(); }
  // the current photo for an angle + phase: a newer one still on the phone wins over the server's
  function cur(job, a, phase) {
    var p = PEND[job.id + "|" + a.id + "|" + phase], s = a[phase];
    if (p && (!s || p.taken >= (s.taken || 0))) return { src: p.url, thumb: p.turl, w: p.w, h: p.h, pending: true, failed: !!p.failed, lens: p.lens, zoom: p.zoom, id: p.id };
    if (s) return { src: A.photoUrl(s.id), thumb: A.photoUrl(s.id, true), w: s.w, h: s.h, id: s.id, hidden: s.hidden, lens: s.meta && s.meta.lens, zoom: s.meta && s.meta.zoom };
    return null;
  }
  function angles(job) { return job.photos.angles; }
  function findAngle(job, aid) { return angles(job).filter(function (a) { return a.id === aid; })[0]; }
  function canvasBlob(c, q) { return new Promise(function (res, rej) { c.toBlob(function (b) { b ? res(b) : rej(new Error("Couldn't save the photo")); }, "image/jpeg", q); }); }
  // draw a source rect into a new canvas (max long side), plus a small thumbnail
  function encode(src, sx, sy, sw, sh) {
    var max = 3000, k = Math.min(1, max / Math.max(sw, sh)), w = Math.round(sw * k), h = Math.round(sh * k);
    var c = document.createElement("canvas"); c.width = w; c.height = h; var x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    var tk = 480 / Math.max(w, h), t = document.createElement("canvas"); t.width = Math.round(w * tk); t.height = Math.round(h * tk); var tx2 = t.getContext("2d"); tx2.imageSmoothingQuality = "high"; tx2.drawImage(c, 0, 0, t.width, t.height);
    return Promise.all([canvasBlob(c, 0.88), canvasBlob(t, 0.72)]).then(function (b) { c.width = c.height = 0; return { full: b[0], thumb: b[1], w: w, h: h }; });
  }
  function crop43(vw, vh) {   // center crop to 4:3 (sideways) or 3:4 (upright)
    var land = vw >= vh, A2 = land ? 4 / 3 : 3 / 4, sw = vw, sh = vh, sx = 0, sy = 0;
    if (vw / vh > A2) { sw = vh * A2; sx = (vw - sw) / 2; } else { sh = vw / A2; sy = (vh - sh) / 2; }
    return [sx, sy, sw, sh];
  }
  function fromFile(file) {
    return new Promise(function (res, rej) {
      var u = URL.createObjectURL(file), img = new Image();
      img.onload = function () { var c = crop43(img.naturalWidth, img.naturalHeight); encode(img, c[0], c[1], c[2], c[3]).then(function (r) { URL.revokeObjectURL(u); res(r); }, rej); };
      img.onerror = function () { URL.revokeObjectURL(u); rej(new Error("That photo couldn't be opened.")); };
      img.src = u;
    });
  }
  function save(job, a, phase, shot, meta) {
    var rec = { id: uuid(), booking: job.id, angle: a.id, phase: phase, taken: Date.now(), w: shot.w, h: shot.h, full: shot.full, thumb: shot.thumb, lens: meta.lens || null, zoom: meta.zoom || null, source: meta.source || "camera" };
    if (phase === "before" && job.state === "scheduled") { job.state = "in_progress"; A.post("/jobs/" + job.id + "/status", { to: "in_progress" }).catch(function () {}); }
    return enqueue(rec).then(function () { return rec; });
  }
  function loadImg(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { rej(new Error("Couldn't load the photo. Check your signal.")); }; i.src = src; }); }
  function openFs(cls, html) { fsRoot.innerHTML = '<div class="fs ' + (cls || "") + '" role="dialog" aria-modal="true">' + html + "</div>"; document.body.classList.add("lock"); return fsRoot.firstChild; }
  function layer(cls, html) { var d = document.createElement("div"); d.className = "fs " + (cls || ""); d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "true"); d.innerHTML = html; fsRoot.appendChild(d); return d; }
  function closeFs() { stopCam(); fsRoot.innerHTML = ""; document.body.classList.remove("lock"); A.reloadJob(); }
  window.addEventListener("apex:route", function () { if (fsRoot.innerHTML) { stopCam(); fsRoot.innerHTML = ""; document.body.classList.remove("lock"); } });

  // ---------- checklist on the job screen ----------
  function checklistHTML(job) {
    var P = job.photos, list = angles(job), cancelled = job.status === "cancelled";
    var nb = list.filter(function (a) { return cur(job, a, "before"); }).length, na = list.filter(function (a) { return cur(job, a, "after"); }).length, n = list.length || 1;
    var h = "";
    if (!P.storage) h += '<p class="note warnc" style="margin:0 0 10px">Photo storage isn\'t turned on yet. Photos you take are kept on this phone and upload once it is.</p>';
    h += '<div class="card"><div class="fg2" style="gap:12px">' +
      '<div><div class="row small"><span>Before</span><b>' + nb + "/" + list.length + '</b></div><div class="prog" style="margin-top:6px"><i style="width:' + Math.round(nb / n * 100) + '%"></i></div></div>' +
      '<div><div class="row small"><span>After</span><b>' + na + "/" + list.length + '</b></div><div class="prog" style="margin-top:6px"><i style="width:' + Math.round(na / n * 100) + '%"></i></div></div></div>' +
      (cancelled ? "" : '<div class="acts"><button class="btn" data-walk="before" style="flex:1">' + window.ApexIC.cam + " Before</button><button class=\"btn" + (nb ? "" : " g") + '" data-walk="after" style="flex:1">' + window.ApexIC.cam + " After</button></div>") + "</div>";
    h += '<div class="angs" style="margin-top:10px">' + list.map(function (a) {
      var b = cur(job, a, "before"), f = cur(job, a, "after"), done = b && f, pins = a.pins.length;
      var slot = function (p, ph) { return '<button class="slot" data-ph-slot="' + esc(a.id) + ":" + ph + '" aria-label="' + esc(a.name) + " " + ph + (p ? "" : " (none yet)") + '">' + (p ? '<img src="' + esc(p.thumb) + '" alt="" loading="lazy">' + (p.pending ? '<i class="q" title="Saved on this phone, uploading"></i>' : "") : (ph === "before" ? "BEFORE" : "AFTER")) + "</button>"; };
      return '<div class="ang' + (done ? " done" : "") + '" data-ph-row="' + esc(a.id) + '"><div class="an"><b>' + esc(a.name) + "</b><small>" + (done ? '<span class="ok-dot" aria-label="Done">✓</span>' : "") + (pins ? '<span class="pin-n" aria-label="' + pins + ' damage marks">' + pins + "</span>" : "") + (a.custom ? "custom" : "") + (b && b.hidden || f && f.hidden ? " · hidden" : "") + "</small></div>" +
        slot(b, "before") + slot(f, "after") + '<button class="more" data-ph-menu="' + esc(a.id) + '" aria-label="More for ' + esc(a.name) + '">⋯</button></div>';
    }).join("") + "</div>";
    if (!cancelled) h += '<div class="acts"><button class="btn g sm" data-ph-add>+ Add angle</button>' + (list.some(function (a) { return cur(job, a, "before") && cur(job, a, "after"); }) ? '<button class="btn g sm" data-ph-compare>Compare &amp; export</button>' : "") + (P.counts.before + P.counts.after ? '<button class="btn g sm" data-ph-zip>Download all</button>' : "") + "</div>";
    if (P.removed && P.removed.length) h += '<p class="note">Removed: ' + P.removed.map(function (r) { return esc(r.name) + ' <button class="lnk" data-ph-restore="' + esc(r.id) + '">restore</button>'; }).join(", ") + "</p>";
    // customer side
    var sh = P.share;
    h += '<div class="card" style="margin-top:12px"><div class="row"><b>Send to the customer</b>' + (P.sentAt ? '<span class="badge good">Sent ' + esc(new Date(P.sentAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })) + "</span>" : "") + "</div>" +
      '<p class="dim small" style="margin:4px 0 0">' + (P.sentAt ? "Their gallery is open. Sending again emails the link again with any new photos." : "Emails them a link to their before & after gallery, where they can save full-size photos and say if you can post them.") + "</p>" +
      '<div class="acts"><button class="btn sm" data-ph-send' + (P.counts.after ? "" : " disabled") + ">" + (P.sentAt ? "Send again" : job.email ? "Email the photos" : "Open their gallery") + '</button><button class="btn g sm" data-copy="' + esc(job.galleryLink) + '">Copy gallery link</button></div>' +
      '<div style="margin-top:12px"><b>OK to post on Instagram/website?</b><p class="dim small" style="margin:2px 0 8px">' + (sh.ok == null ? "Not asked yet. Your terms say only with their permission, plates and address hidden." : (sh.ok ? "Yes" : "No") + " · " + (sh.by === "customer" ? "they answered in their gallery" : "you marked it") + (sh.at ? " " + new Date(sh.at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "")) + '</p><div class="pills"><button data-ph-share="1" aria-pressed="' + (sh.ok === true) + '">They said yes</button><button data-ph-share="0" aria-pressed="' + (sh.ok === false) + '">No</button>' + (sh.ok != null ? '<button data-ph-share="clear">Clear</button>' : "") + "</div></div></div>";
    return h;
  }

  // ---------- camera ----------
  var CAM = null;
  function stopCam() { if (CAM && CAM.stream) CAM.stream.getTracks().forEach(function (t) { t.stop(); }); if (CAM) CAM.alive = false; CAM = null; }
  function lensName(l) { l = String(l || ""); if (/ultra ?wide/i.test(l)) return "0.5×"; if (/tele/i.test(l)) return "Tele"; if (/dual|triple/i.test(l)) return "Auto"; if (/back|rear|environment/i.test(l)) return "1×"; return l.slice(0, 6) || "Cam"; }
  function nextMissing(job, phase, from) {
    var L = angles(job); for (var k = 1; k <= L.length; k++) { var i = (from + k) % L.length; if (!cur(job, L[i], phase)) return i; } return -1;
  }
  function walk(phase, aid) {
    var job = A.job(); if (!job) return;
    var L = angles(job); if (!L.length) return A.toast("Add an angle first.");
    if (!phase) phase = L.some(function (a) { return !cur(job, a, "before"); }) ? "before" : "after";
    var idx = aid ? Math.max(0, L.findIndex(function (a) { return a.id === aid; })) : (function () { var i = L.findIndex(function (a) { return !cur(job, a, phase); }); return i < 0 ? 0 : i; })();
    CAM = { job: job, phase: phase, idx: idx, alive: true, devices: [], device: null, zoom: 1, hwZoom: null, digital: 1, torch: false, last: null };
    var el = openFs("cam", '<div class="fs-top"><button class="ic" data-cam="close" aria-label="Close">' + I.x + '</button><div class="t" id="camT"></div><div class="phase" id="camPh"><button data-cam-ph="before">Before</button><button data-cam-ph="after">After</button></div></div>' +
      '<div class="wprog"><i id="camProg"></i></div>' +
      '<div class="vf-wrap" id="vfw"><div class="vf" id="vf"><video id="camV" playsinline muted autoplay></video><img class="ghost" id="ghost" alt="" hidden><div class="grid" id="grid" hidden></div><div class="flash" id="flash"></div><span class="tag" id="camTag"></span><img class="ref" id="camRef" alt="Before" hidden><span class="zl" id="zl" hidden></span><span class="hint" id="hint" hidden></span><div class="empty-v" id="camMsg" hidden></div></div></div>' +
      '<div class="fs-bot"><div class="lens" id="lens"></div>' +
      '<div class="optrow"><button class="ic" data-cam="grid" aria-label="Grid" aria-pressed="' + PREF.grid + '">' + I.grid + '</button><button class="ic" data-cam="ghost" aria-label="Show the before photo over the camera" aria-pressed="' + PREF.ghost + '" id="ghostBtn">' + I.ghost + '</button><input type="range" id="opac" min="10" max="90" step="5" value="' + Math.round(PREF.opacity * 100) + '" aria-label="Before photo opacity"><button class="ic" data-cam="torch" aria-label="Flashlight" id="torchBtn" hidden>' + I.torch + '</button><button class="ic" data-cam="damage" aria-label="Mark damage" id="dmgBtn">' + I.pin + "</button></div>" +
      '<div class="fs-row"><button class="fs-nav" data-cam="prev">‹ Prev</button><img class="last" id="lastShot" alt="" hidden><button class="shutter" data-cam="shoot" aria-label="Take photo" id="shutter"><i></i></button><button class="ic" data-cam="iphone" aria-label="Use the iPhone camera (full quality)">' + I.iphone + '</button><button class="fs-nav" data-cam="next" id="camNext">Skip ›</button></div>' +
      '<input type="file" id="camFile" accept="image/*" capture="environment" hidden></div>');
    camDraw(); fitVf(); startStream();
    return el;
  }
  function camAngle() { return angles(CAM.job)[CAM.idx]; }
  function camDraw() {
    if (!CAM) return;
    var job = CAM.job, L = angles(job), a = camAngle(), ph = CAM.phase, before = cur(job, a, "before"), mine = cur(job, a, ph);
    var done = L.filter(function (x) { return cur(job, x, ph); }).length;
    document.getElementById("camT").innerHTML = esc(a.name) + "<small>Angle " + (CAM.idx + 1) + " of " + L.length + " · " + done + "/" + L.length + " " + ph + "</small>";
    document.getElementById("camProg").style.width = Math.round(done / L.length * 100) + "%";
    [].forEach.call(document.querySelectorAll("#camPh button"), function (b) { b.setAttribute("aria-pressed", String(b.dataset.camPh === ph)); });
    var tag = document.getElementById("camTag"); tag.textContent = ph === "before" ? "BEFORE" : "AFTER";
    var g = document.getElementById("ghost"), ref = document.getElementById("camRef"), useGhost = ph === "after" && before;
    document.getElementById("ghostBtn").hidden = !useGhost; document.getElementById("opac").hidden = !useGhost || !PREF.ghost;
    if (useGhost) { if (g.dataset.src !== before.src) { g.src = before.src; g.dataset.src = before.src; } g.hidden = !PREF.ghost; g.style.opacity = PREF.opacity; ref.src = before.thumb; ref.hidden = PREF.ghost; } else { g.hidden = true; ref.hidden = true; }
    document.getElementById("grid").hidden = !PREF.grid;
    document.getElementById("dmgBtn").hidden = ph !== "before" || !before;
    document.getElementById("camNext").textContent = mine ? "Next ›" : "Skip ›";
    var last = document.getElementById("lastShot"); if (mine) { last.src = mine.thumb; last.hidden = false; } else last.hidden = true;
    // sideways hint when the Before was taken the other way
    var hint = document.getElementById("hint"), land = window.innerWidth > window.innerHeight;
    if (useGhost && before.w && before.h && (before.w > before.h) !== land) { hint.textContent = before.w > before.h ? "Turn your phone sideways to match the before" : "Hold your phone upright to match the before"; hint.hidden = false; } else hint.hidden = true;
    // lens + zoom matching for Afters
    if (ph === "after" && before && CAM.devices.length > 1 && before.lens) { var d = CAM.devices.filter(function (x) { return x.label === before.lens; })[0]; if (d && CAM.device && d.deviceId !== CAM.device.deviceId) switchLens(d.deviceId, before.zoom); else if (before.zoom && Math.abs((CAM.zoom || 1) - before.zoom) > 0.05) setZoom(before.zoom); }
  }
  function fitVf() {
    var w = document.getElementById("vfw"), v = document.getElementById("vf"); if (!w || !v) return;
    var land = window.innerWidth > window.innerHeight, ar = land ? 4 / 3 : 3 / 4, W = w.clientWidth, H = w.clientHeight;
    var fw = W, fh = W / ar; if (fh > H) { fh = H; fw = H * ar; }
    v.style.width = Math.floor(fw) + "px"; v.style.height = Math.floor(fh) + "px";
  }
  window.addEventListener("resize", function () { if (CAM) { fitVf(); camDraw(); } });
  function camMsg(html) { var m = document.getElementById("camMsg"); if (!m) return; m.innerHTML = html; m.hidden = !html; }
  function startStream(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camMsg('This browser can\'t show the camera here.<br><br><button class="btn" data-cam="iphone">Use the iPhone camera</button>'); return; }
    var c = { audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 4032 }, height: { ideal: 3024 } } : { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } } };
    if (CAM.stream) CAM.stream.getTracks().forEach(function (t) { t.stop(); });
    navigator.mediaDevices.getUserMedia(c).then(function (s) {
      if (!CAM || !CAM.alive) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
      CAM.stream = s; var v = document.getElementById("camV"); v.srcObject = s; v.play().catch(function () {}); camMsg("");
      var tr = s.getVideoTracks()[0], st = tr.getSettings ? tr.getSettings() : {};
      CAM.track = tr; CAM.caps = tr.getCapabilities ? tr.getCapabilities() : {}; CAM.hwZoom = CAM.caps.zoom && CAM.caps.zoom.max > 1 ? CAM.caps.zoom : null; CAM.zoom = st.zoom || 1; CAM.digital = 1; v.style.transform = "";
      document.getElementById("torchBtn").hidden = !CAM.caps.torch;
      return navigator.mediaDevices.enumerateDevices().then(function (ds) {
        var backs = ds.filter(function (d) { return d.kind === "videoinput" && !/front|user|facetime/i.test(d.label); });
        var phys = backs.filter(function (d) { return !/dual|triple/i.test(d.label); });
        CAM.devices = phys.length > 1 ? phys : [];
        CAM.device = backs.filter(function (d) { return d.deviceId === st.deviceId; })[0] || { deviceId: st.deviceId, label: tr.label };
        if (!deviceId && CAM.devices.length > 1 && /dual|triple/i.test(tr.label)) { var wide = CAM.devices.filter(function (d) { return lensName(d.label) === "1×"; })[0]; if (wide) return switchLens(wide.deviceId); }
        drawLens(); camDraw();
      });
    }).catch(function (e) {
      var denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
      camMsg((denied ? "<b>Camera access is off.</b><br>iPhone: Settings → Safari → Camera → Allow (or Settings → Apex Owner if it's on your home screen). Then come back here." : "The camera didn't start (" + esc(e && e.name || "error") + ").") + '<br><br><button class="btn" data-cam="iphone">Use the iPhone camera instead</button> <button class="btn g" data-cam="retry">Try again</button>');
    });
  }
  function drawLens() {
    var el = document.getElementById("lens"); if (!el) return;
    var h = CAM.devices.map(function (d) { return '<button data-lens="' + esc(d.deviceId) + '" aria-pressed="' + (CAM.device && d.deviceId === CAM.device.deviceId) + '">' + esc(lensName(d.label)) + "</button>"; }).join("");
    el.innerHTML = h;
  }
  function switchLens(id, zoom) { var d = CAM.devices.filter(function (x) { return x.deviceId === id; })[0]; CAM.device = d || CAM.device; startStream(id); if (zoom) setTimeout(function () { setZoom(zoom); }, 900); }
  function setZoom(z) {
    if (!CAM) return; var v = document.getElementById("camV"), zl = document.getElementById("zl");
    if (CAM.hwZoom) { z = Math.max(CAM.hwZoom.min || 1, Math.min(Math.min(CAM.hwZoom.max, 10), z)); CAM.zoom = z; CAM.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(function () {}); }
    else { z = Math.max(1, Math.min(3, z)); CAM.digital = z; CAM.zoom = z; v.style.transform = z > 1 ? "scale(" + z + ")" : ""; }
    zl.textContent = (Math.round(CAM.zoom * 10) / 10) + "×"; zl.hidden = false; clearTimeout(setZoom.t); setZoom.t = setTimeout(function () { zl.hidden = true; }, 1200);
  }
  function shoot() {
    var v = document.getElementById("camV"), btn = document.getElementById("shutter");
    if (!CAM || !v || !v.videoWidth || btn.disabled) return;
    btn.disabled = true;
    var fl = document.getElementById("flash"); fl.classList.add("on"); setTimeout(function () { fl.classList.remove("on"); }, 60); A.buzz();
    var vw = v.videoWidth, vh = v.videoHeight, frame = document.getElementById("vf"), land = frame.clientWidth >= frame.clientHeight;
    var ar = land ? 4 / 3 : 3 / 4, sw = vw, sh = vh, sx = 0, sy = 0;
    if (vw / vh > ar) { sw = vh * ar; sx = (vw - sw) / 2; } else { sh = vw / ar; sy = (vh - sh) / 2; }
    if (CAM.digital > 1) { var nw = sw / CAM.digital, nh = sh / CAM.digital; sx += (sw - nw) / 2; sy += (sh - nh) / 2; sw = nw; sh = nh; }
    var job = CAM.job, a = camAngle(), ph = CAM.phase, meta = { lens: CAM.device && CAM.device.label, zoom: CAM.zoom, source: "camera" };
    encode(v, sx, sy, sw, sh).then(function (shot) { return save(job, a, ph, shot, meta); }).then(function () { btn.disabled = false; advance(); }).catch(function (e) { btn.disabled = false; A.toast(e.message || "Couldn't save that photo", true); });
  }
  function advance() {
    if (!CAM) return;
    var n = nextMissing(CAM.job, CAM.phase, CAM.idx);
    if (n < 0) {   // every angle has a photo for this phase
      camDraw();
      var msg = CAM.phase === "before" ? "All before photos done." : "All after photos done.";
      A.toast(msg); camMsg("<b>" + msg + "</b><br><br>" + (CAM.phase === "before" ? '<button class="btn" data-cam="close">Done for now</button> <button class="btn g" data-cam-ph="after">Start after photos</button>' : '<button class="btn" data-cam="close">Done</button>'));
      return;
    }
    CAM.idx = n; camDraw();
  }
  function iphoneShot() {
    var inp = document.getElementById("camFile"); if (!inp) return; inp.value = ""; inp.click();
  }
  function onFile(file) {
    if (!file || !CAM) return; var job = CAM.job, a = camAngle(), ph = CAM.phase;
    A.toast("Saving…");
    fromFile(file).then(function (shot) { return save(job, a, ph, shot, { source: "iphone" }); }).then(function () { camMsg(""); advance(); }).catch(function (e) { A.toast(e.message, true); });
  }
  // pinch to zoom, tap to focus (when the browser supports it)
  var pinch = null;
  document.addEventListener("touchstart", function (e) { if (!CAM || !e.target.closest("#vf")) return; if (e.touches.length === 2) { pinch = { d: dist(e.touches), z: CAM.zoom || 1 }; } }, { passive: true });
  document.addEventListener("touchmove", function (e) { if (!pinch || !CAM || e.touches.length !== 2) return; setZoom(pinch.z * dist(e.touches) / pinch.d); }, { passive: true });
  document.addEventListener("touchend", function (e) { if (e.touches.length < 2) pinch = null; }, { passive: true });
  function dist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy) || 1; }
  function tapFocus(e) {
    if (!CAM || !CAM.track || !CAM.caps) return;
    var sup = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    if (!sup.pointsOfInterest || !CAM.caps.focusMode) return;
    var r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    CAM.track.applyConstraints({ advanced: [{ pointsOfInterest: [{ x: x, y: y }], focusMode: CAM.caps.focusMode.indexOf("single-shot") > -1 ? "single-shot" : "continuous" }] }).catch(function () {});
  }

  // ---------- single photo viewer ----------
  function viewer(aid, phase) {
    var job = A.job(), a = findAngle(job, aid), p = cur(job, a, phase); if (!p) return walk(phase, aid);
    var el = openFs("", '<div class="fs-top"><button class="ic" data-v="close" aria-label="Close">' + I.x + '</button><div class="t">' + esc(a.name) + "<small>" + (phase === "before" ? "Before" : "After") + (p.pending ? " · on this phone, uploading" : "") + (p.hidden ? " · hidden from the customer" : "") + '</small></div><span style="width:42px"></span></div>' +
      '<div class="vf-wrap"><img src="' + esc(p.src) + '" alt="" style="max-width:100%;max-height:100%;object-fit:contain"></div>' +
      '<div class="fs-bot"><div class="fs-row" style="justify-content:center;flex-wrap:wrap;gap:8px">' +
      '<button class="btn" data-v="retake">Retake</button>' + (phase === "before" ? '<button class="btn g" data-v="damage">Mark damage' + (a.pins.length ? " (" + a.pins.length + ")" : "") + "</button>" : "") +
      (cur(job, a, phase === "before" ? "after" : "before") ? '<button class="btn g" data-v="compare">Compare</button>' : "") +
      (!p.pending ? '<button class="btn g" data-v="hide">' + (p.hidden ? "Show to customer" : "Hide from customer") + '</button><button class="btn d" data-v="delete">Delete</button>' : "") + "</div></div>");
    el.dataset.aid = aid; el.dataset.phase = phase; el.dataset.pid = p.id || "";
  }

  // ---------- damage pins ----------
  var DM = null;
  function damage(aid) {
    var job = A.job(), a = findAngle(job, aid), p = cur(job, a, "before");
    if (!p) return A.toast("Take the before photo first.");
    DM = { job: job, a: a, pins: a.pins.map(function (x) { return Object.assign({}, x); }), notes: a.notes || "", sel: -1, el: null };
    DM.el = layer("", '<div class="fs-top"><button class="ic" data-dm="close" aria-label="Close">' + I.x + '</button><div class="t">Damage · ' + esc(a.name) + '<small>Tap the photo where the damage is</small></div><button class="btn sm" data-dm="done">Done</button></div>' +
      '<div class="vf-wrap" id="dmWrap" style="touch-action:manipulation"><div class="dmg" id="dmg"><img id="dmImg" src="' + esc(p.src) + '" alt="Before photo"></div></div>' +
      '<div class="fs-bot" style="max-height:44vh;overflow-y:auto;touch-action:pan-y"><div id="dmPanel"></div><div id="dmList"></div><label class="f" style="color:#bbb">General notes for this angle<textarea id="dmNotes" style="min-height:60px" placeholder="e.g. Light swirls all over the hood">' + esc(DM.notes) + "</textarea></label></div>");
    var img = document.getElementById("dmImg");
    img.onload = fitDmg; if (img.complete) fitDmg();
    dmDraw();
  }
  function fitDmg() {
    var w = document.getElementById("dmWrap"), d = document.getElementById("dmg"), img = document.getElementById("dmImg"); if (!w || !img || !img.naturalWidth) return;
    var ar = img.naturalWidth / img.naturalHeight, W = w.clientWidth - 16, H = w.clientHeight - 16, fw = W, fh = W / ar; if (fh > H) { fh = H; fw = H * ar; }
    d.style.width = Math.floor(fw) + "px"; d.style.height = Math.floor(fh) + "px";
  }
  function dmDraw() {
    var d = document.getElementById("dmg"); if (!d) return;
    [].forEach.call(d.querySelectorAll(".pin"), function (x) { x.remove(); });
    DM.pins.forEach(function (p, i) { var b = document.createElement("button"); b.className = "pin"; b.textContent = i + 1; b.style.left = p.x * 100 + "%"; b.style.top = p.y * 100 + "%"; b.dataset.dmPin = i; b.setAttribute("aria-label", "Damage " + (i + 1) + ": " + p.label); if (i === DM.sel) b.style.boxShadow = "0 0 0 3px #ffd27a"; d.appendChild(b); });
    document.getElementById("dmList").innerHTML = DM.pins.length ? DM.pins.map(function (p, i) { return '<div class="row" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1)"><span><span class="pin-n">' + (i + 1) + "</span> <b>" + esc(p.label) + "</b>" + (p.note ? ' <span class="dim">· ' + esc(p.note) + "</span>" : "") + '</span><button class="lnk" data-dm-pin="' + i + '">Edit</button></div>'; }).join("") : '<p class="dim small" style="margin:0 0 8px">No damage marked yet.</p>';
    var pn = document.getElementById("dmPanel");
    if (DM.sel < 0) { pn.innerHTML = ""; return; }
    var p = DM.pins[DM.sel];
    pn.innerHTML = '<div class="card" style="margin-bottom:10px"><b>Damage ' + (DM.sel + 1) + '</b><div class="pills" style="margin:8px 0">' + LABELS.map(function (l) { return '<button data-dm-lbl="' + esc(l) + '" aria-pressed="' + (p.label === l) + '">' + l + "</button>"; }).join("") + "</div>" +
      '<input type="text" id="dmNote" maxlength="200" placeholder="Note (optional), or type your own label" value="' + esc(p.note || "") + '"><div class="acts"><button class="btn sm" data-dm="ok">Save</button><button class="btn d sm" data-dm="del">Delete</button></div></div>';
  }
  function dmSave(close) {
    var n = document.getElementById("dmNotes"); if (n) DM.notes = n.value;
    var body = { pins: DM.pins, notes: DM.notes }, job = DM.job, a = DM.a;
    return A.post("/jobs/" + job.id + "/angles/" + a.id, body).then(function () { a.pins = DM.pins.slice(); a.notes = DM.notes; if (close) { DM.el.remove(); DM = null; if (CAM) camDraw(); if (!fsRoot.querySelector(".fs")) { document.body.classList.remove("lock"); A.reloadJob(); } } A.buzz(); })
      .catch(function (e) { A.toast("Couldn't save the damage marks: " + e.message, true); });
  }

  // ---------- compare + export ----------
  var CMP = null;
  function compare(aid) {
    var job = A.job(), pairs = angles(job).filter(function (a) { return cur(job, a, "before") && cur(job, a, "after"); });
    if (!pairs.length) return A.toast("Take a before and an after of the same angle first.");
    var start = Math.max(0, pairs.findIndex(function (a) { return a.id === aid; }));
    CMP = { job: job, pairs: pairs, i: start, mode: "slider", pos: 50, exp: null };
    stopCam();
    openFs("", '<div class="fs-top"><button class="ic" data-cmp="close" aria-label="Close">' + I.x + '</button><div class="t" id="cmpT"></div><div class="phase"><button data-cmp-mode="slider">Slider</button><button data-cmp-mode="side">Side by side</button></div></div>' +
      '<div class="vf-wrap" id="cmpWrap"></div><div class="strip" id="cmpStrip"></div><div class="fs-bot"><button class="btn lg w" data-cmp="export">' + I.share + " Export &amp; share</button></div>");
    cmpDraw();
  }
  function cmpDraw() {
    var a = CMP.pairs[CMP.i], b = cur(CMP.job, a, "before"), f = cur(CMP.job, a, "after"), W = document.getElementById("cmpWrap");
    document.getElementById("cmpT").innerHTML = esc(a.name) + "<small>" + (CMP.i + 1) + " of " + CMP.pairs.length + "</small>";
    [].forEach.call(document.querySelectorAll("[data-cmp-mode]"), function (x) { x.setAttribute("aria-pressed", String(x.dataset.cmpMode === CMP.mode)); });
    var ww = W.clientWidth - 16, wh = W.clientHeight - 16, ar = (f.w && f.h ? f.w / f.h : 4 / 3);
    if (CMP.mode === "slider") {
      var fw = ww, fh = ww / ar; if (fh > wh) { fh = wh; fw = wh * ar; }
      W.innerHTML = '<div class="cmpv" id="cmpv" style="width:' + Math.floor(fw) + "px;height:" + Math.floor(fh) + 'px"><img src="' + esc(b.src) + '" alt="Before"><div class="aft" id="cmpA" style="clip-path:inset(0 0 0 ' + CMP.pos + '%)"><img src="' + esc(f.src) + '" alt="After"></div><div class="div" id="cmpD" style="left:' + CMP.pos + '%"><span>⇆</span></div><span class="lbl" style="left:10px">BEFORE</span><span class="lbl" style="right:10px">AFTER</span></div>';
    } else {
      var stack = ar > 1.05; // sideways photos stack so they stay big
      var cw = stack ? ww : (ww - 8) / 2, ch = cw / ar, total = stack ? ch * 2 + 8 : ch;
      if (total > wh) { var k = wh / total; cw *= k; ch *= k; }
      var box = function (p, l) { return '<div style="position:relative;width:' + Math.floor(cw) + "px;height:" + Math.floor(ch) + 'px;border-radius:10px;overflow:hidden"><img src="' + esc(p.src) + '" alt="' + l + '" style="width:100%;height:100%;object-fit:cover"><span class="lbl" style="left:8px">' + l.toUpperCase() + "</span></div>"; };
      W.innerHTML = '<div style="display:flex;flex-direction:' + (stack ? "column" : "row") + ';gap:8px;align-items:center;justify-content:center;height:100%">' + box(b, "Before") + box(f, "After") + "</div>";
    }
    document.getElementById("cmpStrip").innerHTML = CMP.pairs.length > 1 ? CMP.pairs.map(function (p, i) { return '<button data-cmp-i="' + i + '" aria-pressed="' + (i === CMP.i) + '"><img src="' + esc(cur(CMP.job, p, "after").thumb) + '" alt="">' + esc(p.name) + "</button>"; }).join("") : "";
  }
  function slide(e) { var v = document.getElementById("cmpv"); if (!v) return; var r = v.getBoundingClientRect(); CMP.pos = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)); document.getElementById("cmpA").style.clipPath = "inset(0 0 0 " + CMP.pos + "%)"; document.getElementById("cmpD").style.left = CMP.pos + "%"; }

  function exportView() {
    var a = CMP.pairs[CMP.i], job = CMP.job;
    CMP.exp = { layout: "side", labels: true, pins: false, blur: [], blurMode: false, imgs: null };
    var sh = job.photos.share;
    var el = layer("", '<div class="fs-top"><button class="ic" data-ex="close" aria-label="Back">' + I.x + '</button><div class="t">Export · ' + esc(a.name) + '<small>' + (sh.ok === true ? "OK to post" : sh.ok === false ? "Customer said NOT to post" : "Not OK'd to post yet (fine to send to them)") + '</small></div><span style="width:42px"></span></div>' +
      '<div class="vf-wrap" style="padding:8px"><canvas id="exC" class="exp-prev" aria-label="Preview"></canvas></div>' +
      '<div class="fs-bot"><div class="optrow" style="flex-wrap:wrap"><div class="phase"><button data-ex-l="side" aria-pressed="true">Side by side</button><button data-ex-l="stack" aria-pressed="false">Stacked</button></div>' +
      '<button class="ic" data-ex="labels" aria-pressed="true" aria-label="Before/after labels" style="width:auto;padding:0 12px;border-radius:999px;font-size:12.5px">Labels</button>' +
      '<button class="ic" data-ex="pins" aria-pressed="false" aria-label="Damage pins" style="width:auto;padding:0 12px;border-radius:999px;font-size:12.5px">Pins</button>' +
      '<button class="ic" data-ex="blur" aria-pressed="false" aria-label="Blur a plate or address: drag on the photo" style="width:auto;padding:0 12px;border-radius:999px;font-size:12.5px">' + "Blur</button></div>" +
      '<p class="dim small" id="exHint" style="margin:0;text-align:center">Tip: turn on Blur and drag over plates or house numbers.</p>' +
      '<div class="fs-row"><button class="fs-nav" data-ex="undo" id="exUndo" hidden>Undo blur</button><button class="btn lg" data-ex="share" style="flex:1">' + I.share + " Share or save</button></div></div>");
    Promise.all([loadImg(cur(job, a, "before").src), loadImg(cur(job, a, "after").src)]).then(function (imgs) { if (!CMP || !CMP.exp) return; CMP.exp.imgs = imgs; exRender(document.getElementById("exC"), 1100); })
      .catch(function (e) { A.toast(e.message, true); });
    return el;
  }
  // build the comparison image; maxSide limits the output (preview small, export full)
  function exLayout(maxSide) {
    var E = CMP.exp, b = E.imgs[0], f = E.imgs[1], ar = f.naturalWidth / f.naturalHeight, stack = E.layout === "stack";
    var cell = Math.min(1600, Math.max(f.naturalWidth, f.naturalHeight)), cw = ar >= 1 ? cell : Math.round(cell * ar), ch = ar >= 1 ? Math.round(cell / ar) : cell, gap = Math.round(cell * 0.012);
    var W = stack ? cw : cw * 2 + gap, H = stack ? ch * 2 + gap : ch, k = Math.min(1, maxSide / Math.max(W, H));
    return { k: k, W: Math.round(W * k), H: Math.round(H * k), cw: cw * k, ch: ch * k, gap: gap * k, stack: stack, b: b, f: f };
  }
  function cellRect(Lx, which) { return which === 0 ? { x: 0, y: 0, w: Lx.cw, h: Lx.ch } : Lx.stack ? { x: 0, y: Lx.ch + Lx.gap, w: Lx.cw, h: Lx.ch } : { x: Lx.cw + Lx.gap, y: 0, w: Lx.cw, h: Lx.ch }; }
  function drawCover(x, img, r) {   // object-fit: cover
    var ia = img.naturalWidth / img.naturalHeight, ra = r.w / r.h, sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (ia > ra) { sw = sh * ra; sx = (img.naturalWidth - sw) / 2; } else { sh = sw / ra; sy = (img.naturalHeight - sh) / 2; }
    x.drawImage(img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
  }
  function pixelate(x, c, r) {
    var px = Math.max(6, Math.round(Math.max(r.w, r.h) / 14)), tw = Math.max(1, Math.round(r.w / px)), th = Math.max(1, Math.round(r.h / px));
    var t = document.createElement("canvas"); t.width = tw; t.height = th; t.getContext("2d").drawImage(c, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    x.save(); x.imageSmoothingEnabled = false; x.drawImage(t, 0, 0, tw, th, r.x, r.y, r.w, r.h); x.restore();
  }
  function exRender(c, maxSide) {
    var E = CMP.exp; if (!E.imgs) return null;
    var Lx = exLayout(maxSide), a = CMP.pairs[CMP.i]; c.width = Lx.W; c.height = Lx.H;
    var x = c.getContext("2d"); x.fillStyle = "#000"; x.fillRect(0, 0, Lx.W, Lx.H); x.imageSmoothingQuality = "high";
    [0, 1].forEach(function (i) {
      var r = cellRect(Lx, i); drawCover(x, i ? Lx.f : Lx.b, r);
      E.blur.filter(function (bl) { return bl.i === i; }).forEach(function (bl) { pixelate(x, c, { x: r.x + bl.x * r.w, y: r.y + bl.y * r.h, w: Math.max(2, bl.w * r.w), h: Math.max(2, bl.h * r.h) }); });
      if (E.pins && i === 0) a.pins.forEach(function (p, n) { var px = r.x + p.x * r.w, py = r.y + p.y * r.h, rr = Math.max(9, r.w * 0.022); x.beginPath(); x.arc(px, py, rr, 0, 7); x.fillStyle = "#e5484d"; x.fill(); x.lineWidth = rr * 0.18; x.strokeStyle = "#fff"; x.stroke(); x.fillStyle = "#fff"; x.font = "800 " + Math.round(rr * 1.1) + "px -apple-system, system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(String(n + 1), px, py + rr * 0.05); });
      if (E.labels) { var fs = Math.max(11, Math.round(r.w * 0.035)), t = i ? "AFTER" : "BEFORE"; x.font = "800 " + fs + "px -apple-system, system-ui, sans-serif"; var tw = x.measureText(t).width + fs * 1.6, th = fs * 1.9, lx = r.x + fs * 0.7, ly = r.y + fs * 0.7;
        x.fillStyle = "rgba(0,0,0,.62)"; roundRect(x, lx, ly, tw, th, th / 2); x.fill(); x.fillStyle = "#fff"; x.textAlign = "left"; x.textBaseline = "middle"; x.fillText(t, lx + fs * 0.8, ly + th / 2 + fs * 0.05); }
    });
    // small "Apex Detailing" watermark, bottom right
    var wf = Math.max(10, Math.round(Math.min(Lx.W, Lx.H) * 0.028)); x.font = "700 " + wf + "px -apple-system, system-ui, sans-serif"; x.textAlign = "right"; x.textBaseline = "alphabetic";
    x.shadowColor = "rgba(0,0,0,.6)"; x.shadowBlur = wf * 0.5; x.fillStyle = "rgba(255,255,255,.82)"; x.fillText("APEX DETAILING", Lx.W - wf * 0.9, Lx.H - wf * 0.8); x.shadowBlur = 0;
    CMP.exp.L = Lx; return c;
  }
  function roundRect(x, l, t, w, h, r) { x.beginPath(); x.moveTo(l + r, t); x.arcTo(l + w, t, l + w, t + h, r); x.arcTo(l + w, t + h, l, t + h, r); x.arcTo(l, t + h, l, t, r); x.arcTo(l, t, l + w, t, r); x.closePath(); }
  function exShare() {
    var E = CMP.exp, a = CMP.pairs[CMP.i], job = CMP.job; if (!E.imgs) return;
    var c = exRender(document.createElement("canvas"), 3200), name = [job.name, a.name, "Before & After"].join(" - ").replace(/[\/\\:*?"<>|]+/g, "") + ".jpg";
    canvasBlob(c, 0.9).then(function (blob) {
      exRender(document.getElementById("exC"), 1100);
      var file = new File([blob], name, { type: "image/jpeg" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: name }).catch(function (e) { if (e && e.name !== "AbortError") download(blob, name); });
      download(blob, name);
    });
  }
  function download(blob, name) { var u = URL.createObjectURL(blob), l = document.createElement("a"); l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 30000); }
  // drag to add a blur box on the export preview
  var drag = null;
  function exPoint(e) {
    var c = document.getElementById("exC"), Lx = CMP.exp.L; if (!c || !Lx) return null;
    var r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * Lx.W, y = (e.clientY - r.top) / r.height * Lx.H;
    for (var i = 0; i < 2; i++) { var q = cellRect(Lx, i); if (x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h) return { i: i, x: (x - q.x) / q.w, y: (y - q.y) / q.h }; }
    return null;
  }

  // ---------- zip of every photo on a job (no compression: photos are already JPEG) ----------
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u) { var c = 0xffffffff; for (var i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) {
    var parts = [], central = [], off = 0, enc = new TextEncoder();
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true);
      parts.push(h.buffer, name, data);
      var c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(c.buffer, name); off += 30 + name.length + data.length;
    });
    var csize = central.reduce(function (t, p) { return t + (p.byteLength || p.length); }, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
    return new Blob(parts.concat(central, [e.buffer]), { type: "application/zip" });
  }
  function zipJob(btn) {
    var job = A.job(), list = [];
    angles(job).forEach(function (a) { ["before", "after"].forEach(function (ph) { var p = cur(job, a, ph); if (p) list.push({ name: a.name.replace(/[\/\\:*?"<>|]+/g, "") + " - " + (ph === "before" ? "Before" : "After") + ".jpg", src: p.src }); }); });
    if (!list.length) return;
    var t = btn.textContent; btn.disabled = true; var n = 0;
    Promise.all(list.map(function (f) { return fetch(f.src, { credentials: "same-origin" }).then(function (r) { if (!r.ok) throw new Error("Couldn't download a photo"); return r.arrayBuffer(); }).then(function (b) { btn.textContent = "Downloading " + (++n) + "/" + list.length; return { name: f.name, data: new Uint8Array(b) }; }); }))
      .then(function (files) { var name = (job.name + " - " + job.day + " - Apex photos").replace(/[\/\\:*?"<>|]+/g, "") + ".zip", blob = zip(files), file = new File([blob], name, { type: "application/zip" });
        if (navigator.canShare && navigator.canShare({ files: [file] })) return navigator.share({ files: [file], title: name }).catch(function () { download(blob, name); });
        download(blob, name); })
      .catch(function (e) { A.toast(e.message, true); }).then(function () { btn.disabled = false; btn.textContent = t; });
  }

  // ---------- angle menu ----------
  function angleMenu(aid) {
    var job = A.job(), a = findAngle(job, aid), b = cur(job, a, "before"), f = cur(job, a, "after");
    A.openSheet(a.name, '<div class="menu"><button class="btn" data-am="before">' + (b ? "Retake" : "Take") + ' before</button><button class="btn g" data-am="after">' + (f ? "Retake" : "Take") + " after</button>" +
      (b ? '<button class="btn g" data-am="damage">Mark damage' + (a.pins.length ? " (" + a.pins.length + ")" : "") + "</button>" : "") + (b && f ? '<button class="btn g" data-am="compare">Compare &amp; export</button>' : "") +
      '<button class="btn g" data-am="rename">Rename</button><button class="btn d" data-am="remove">Remove this angle</button></div>', { close: "Close", guard: false }).dataset.aid = aid;
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target, b, job;
    if ((b = t.closest("[data-walk]"))) { e.stopPropagation(); return walk(b.dataset.walk); }
    if ((b = t.closest("[data-ph-slot]"))) { var sp = b.dataset.phSlot.split(":"); job = A.job(); return cur(job, findAngle(job, sp[0]), sp[1]) ? viewer(sp[0], sp[1]) : walk(sp[1], sp[0]); }
    if ((b = t.closest("[data-ph-menu]"))) return angleMenu(b.dataset.phMenu);
    if ((b = t.closest("[data-am]"))) { var aid = t.closest(".sheet").dataset.aid, act = b.dataset.am; A.closeSheet(true);
      if (act === "before" || act === "after") return walk(act, aid);
      if (act === "damage") { document.body.classList.add("lock"); return damage(aid); }
      if (act === "compare") return compare(aid);
      if (act === "rename") { var nm = prompt("Angle name", findAngle(A.job(), aid).name); if (nm) A.post("/jobs/" + A.job().id + "/angles/" + aid, { name: nm }).then(A.reloadJob).catch(function (e2) { A.toast(e2.message); }); return; }
      if (act === "remove") { if (!confirm("Remove this angle from the checklist? Its photos are kept and you can restore it.")) return; A.post("/jobs/" + A.job().id + "/angles/" + aid, { remove: true }).then(A.reloadJob).catch(function (e2) { A.toast(e2.message); }); return; }
    }
    if (t.closest("[data-ph-add]")) { var name = prompt("New angle (for example: Engine Bay, Trunk, Third Row)"); if (name && name.trim()) A.post("/jobs/" + A.job().id + "/angles", { name: name.trim() }).then(function () { A.toast("Added"); A.reloadJob(); }).catch(function (e2) { A.toast(e2.message); }); return; }
    if ((b = t.closest("[data-ph-restore]"))) { A.post("/jobs/" + A.job().id + "/angles/" + b.dataset.phRestore, { restore: true }).then(A.reloadJob).catch(function (e2) { A.toast(e2.message); }); return; }
    if (t.closest("[data-ph-compare]")) return compare();
    if ((b = t.closest("[data-ph-zip]"))) return zipJob(b);
    if ((b = t.closest("[data-ph-send]"))) { job = A.job(); if (Q.some(function (r) { return r.booking === job.id; }) && !confirm("Some photos are still uploading from this phone. Send anyway? (They'll show in the gallery once they finish.)")) return;
      if (!confirm(job.email ? "Email " + job.email + " a link to their photos?" : "Open their gallery? (No email on file: we'll copy the link for you to text.)")) return;
      b.disabled = true; A.post("/jobs/" + job.id + "/send-photos").then(function (r) { A.toast(r.sent ? "Sent to " + job.email : "Gallery is open. Link copied."); if (!r.sent && r.link) A.copy(r.link); A.reloadJob(); }).catch(function (e2) { b.disabled = false; A.toast(e2.message, true); }); return; }
    if ((b = t.closest("[data-ph-share]"))) { job = A.job(); var v = b.dataset.phShare, ok = v === "1" ? true : v === "0" ? false : null; A.post("/jobs/" + job.id + "/share", { ok: ok }).then(A.reloadJob).catch(function (e2) { A.toast(e2.message); }); return; }
    if ((b = t.closest("[data-qdrop]"))) { if (!confirm("Discard this photo from the phone? It never uploaded.")) return; var r0 = Q.filter(function (r) { return r.id === b.dataset.qdrop; })[0]; if (r0) { Q = Q.filter(function (r) { return r !== r0; }); unmark(r0); tx("readwrite", function (st) { st.delete(r0.id); }); pill(); A.closeSheet(true); } return; }
    if (t.closest("[data-qnow]")) { Q.forEach(function (r) { delete r.failed; }); A.closeSheet(true); pump(); return; }
    // camera
    if ((b = t.closest("[data-cam]"))) {
      var c = b.dataset.cam;
      if (c === "close") return closeFs();
      if (c === "shoot") return shoot();
      if (c === "prev") { CAM.idx = (CAM.idx - 1 + angles(CAM.job).length) % angles(CAM.job).length; camMsg(""); return camDraw(); }
      if (c === "next") { CAM.idx = (CAM.idx + 1) % angles(CAM.job).length; camMsg(""); return camDraw(); }
      if (c === "grid") { PREF.grid = !PREF.grid; savePref(); b.setAttribute("aria-pressed", String(PREF.grid)); return camDraw(); }
      if (c === "ghost") { PREF.ghost = !PREF.ghost; savePref(); b.setAttribute("aria-pressed", String(PREF.ghost)); return camDraw(); }
      if (c === "torch") { CAM.torch = !CAM.torch; b.setAttribute("aria-pressed", String(CAM.torch)); CAM.track.applyConstraints({ advanced: [{ torch: CAM.torch }] }).catch(function () {}); return; }
      if (c === "iphone") return iphoneShot();
      if (c === "retry") { camMsg(""); return startStream(); }
      if (c === "damage") return damage(camAngle().id);
    }
    if ((b = t.closest("[data-cam-ph]"))) { if (!CAM) return; CAM.phase = b.dataset.camPh; var i0 = angles(CAM.job).findIndex(function (a) { return !cur(CAM.job, a, CAM.phase); }); CAM.idx = i0 < 0 ? CAM.idx : i0; camMsg(""); return camDraw(); }
    if ((b = t.closest("[data-lens]"))) return switchLens(b.dataset.lens);
    if (t.closest("#vf") && CAM && !t.closest("button")) return tapFocus({ currentTarget: document.getElementById("vf"), clientX: e.clientX, clientY: e.clientY });
    // viewer
    if ((b = t.closest("[data-v]"))) {
      var fsEl = t.closest(".fs"), vaid = fsEl.dataset.aid, vph = fsEl.dataset.phase, pid = fsEl.dataset.pid, va = b.dataset.v;
      if (va === "close") return closeFs();
      if (va === "retake") { fsRoot.innerHTML = ""; return walk(vph, vaid); }
      if (va === "damage") return damage(vaid);
      if (va === "compare") { fsRoot.innerHTML = ""; return compare(vaid); }
      if (va === "hide") { var hid = !/Show/.test(b.textContent); A.post("/photos/" + pid + "/hide", { hidden: hid }).then(function () { A.toast(hid ? "Hidden from the customer" : "Showing to the customer"); closeFs(); }).catch(function (e2) { A.toast(e2.message); }); return; }
      if (va === "delete") { if (!confirm("Delete this photo?")) return; A.post("/photos/" + pid + "/delete").then(function () { A.toast("Deleted"); closeFs(); }).catch(function (e2) { A.toast(e2.message); }); return; }
    }
    // damage
    if ((b = t.closest("[data-dm]")) && DM) {
      var d = b.dataset.dm;
      if (d === "close") { if (JSON.stringify(DM.pins) !== JSON.stringify(DM.a.pins) && !confirm("Discard these damage marks?")) return; DM.el.remove(); DM = null; if (!fsRoot.querySelector(".fs")) { document.body.classList.remove("lock"); } return; }
      if (d === "done") return dmSave(true);
      if (d === "ok") { var p = DM.pins[DM.sel], nt = document.getElementById("dmNote").value.trim(); if (nt && LABELS.indexOf(p.label) < 0 && p.label === "Damage") { p.label = nt.slice(0, 30); p.note = ""; } else p.note = nt; DM.sel = -1; dmDraw(); return dmSave(false); }
      if (d === "del") { DM.pins.splice(DM.sel, 1); DM.sel = -1; dmDraw(); return dmSave(false); }
    }
    if ((b = t.closest("[data-dm-lbl]")) && DM) { DM.pins[DM.sel].label = b.dataset.dmLbl; return dmDraw(); }
    if ((b = t.closest("[data-dm-pin]")) && DM) { DM.sel = +b.dataset.dmPin; return dmDraw(); }
    if (t.closest("#dmg") && DM && !t.closest(".pin")) {
      var r = document.getElementById("dmg").getBoundingClientRect(); if (DM.pins.length >= 40) return A.toast("That's the most marks for one photo.");
      DM.pins.push({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, label: "Damage", note: "" }); DM.sel = DM.pins.length - 1; A.buzz(); return dmDraw();
    }
    // compare
    if ((b = t.closest("[data-cmp]")) && CMP) { if (b.dataset.cmp === "close") { CMP = null; return closeFs(); } if (b.dataset.cmp === "export") return exportView(); }
    if ((b = t.closest("[data-cmp-mode]")) && CMP) { CMP.mode = b.dataset.cmpMode; return cmpDraw(); }
    if ((b = t.closest("[data-cmp-i]")) && CMP) { CMP.i = +b.dataset.cmpI; return cmpDraw(); }
    // export
    if ((b = t.closest("[data-ex]")) && CMP && CMP.exp) {
      var x = b.dataset.ex, E = CMP.exp, cv = document.getElementById("exC");
      if (x === "close") { t.closest(".fs").remove(); CMP.exp = null; return; }
      if (x === "labels" || x === "pins") { E[x] = !E[x]; b.setAttribute("aria-pressed", String(E[x])); return exRender(cv, 1100); }
      if (x === "blur") { E.blurMode = !E.blurMode; b.setAttribute("aria-pressed", String(E.blurMode)); document.getElementById("exHint").textContent = E.blurMode ? "Drag over a plate, house number or anything private." : "Tip: turn on Blur and drag over plates or house numbers."; return; }
      if (x === "undo") { E.blur.pop(); document.getElementById("exUndo").hidden = !E.blur.length; return exRender(cv, 1100); }
      if (x === "share") return exShare();
    }
    if ((b = t.closest("[data-ex-l]")) && CMP && CMP.exp) { CMP.exp.layout = b.dataset.exL; [].forEach.call(b.parentNode.children, function (y) { y.setAttribute("aria-pressed", String(y === b)); }); CMP.exp.blur = []; document.getElementById("exUndo").hidden = true; return exRender(document.getElementById("exC"), 1100); }
  }, true);
  document.addEventListener("change", function (e) { if (e.target.id === "camFile" && e.target.files && e.target.files[0]) onFile(e.target.files[0]); });
  document.addEventListener("input", function (e) { if (e.target.id === "opac") { PREF.opacity = +e.target.value / 100; savePref(); var g = document.getElementById("ghost"); if (g) g.style.opacity = PREF.opacity; } });
  // long-press a checklist row for its menu
  var lp = null;
  document.addEventListener("pointerdown", function (e) {
    var row = e.target.closest && e.target.closest("[data-ph-row]");
    if (row && !e.target.closest("button")) { lp = setTimeout(function () { A.buzz(); angleMenu(row.dataset.phRow); }, 500); }
    if (CMP && !CMP.exp && e.target.closest("#cmpv")) { CMP.drag = true; slide(e); }
    if (CMP && CMP.exp && CMP.exp.blurMode && e.target.id === "exC") { var p = exPoint(e); if (p) { drag = { s: p }; e.target.setPointerCapture(e.pointerId); } }
  });
  document.addEventListener("pointermove", function (e) {
    if (lp) { clearTimeout(lp); lp = null; }
    if (CMP && CMP.drag) slide(e);
    if (drag && CMP && CMP.exp) { var p = exPoint(e); if (p && p.i === drag.s.i) drag.e = p; }
  });
  document.addEventListener("pointerup", function () {
    if (lp) { clearTimeout(lp); lp = null; }
    if (CMP) CMP.drag = false;
    if (drag && drag.e && CMP && CMP.exp) { var s = drag.s, f = drag.e, bx = { i: s.i, x: Math.min(s.x, f.x), y: Math.min(s.y, f.y), w: Math.abs(f.x - s.x), h: Math.abs(f.y - s.y) }; if (bx.w > 0.01 && bx.h > 0.01) { CMP.exp.blur.push(bx); document.getElementById("exUndo").hidden = false; exRender(document.getElementById("exC"), 1100); } }
    drag = null;
  });
  document.addEventListener("contextmenu", function (e) { if (e.target.closest && e.target.closest("[data-ph-row]")) e.preventDefault(); });

  window.ApexPhotos = { checklistHTML: checklistHTML, pendingCount: pendingCount, retry: function () { Q.forEach(function (r) { delete r.failed; }); pump(); } };
  qLoad().then(pump);
})();
