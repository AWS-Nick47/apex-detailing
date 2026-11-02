/* Apex Owner dashboard (v2, Nov 2). Tabs: Today, Schedule, Jobs, People, Money, Settings.
   Detail screens: #job/<code>, #customer/<id>, #member/<id>. Photo tools live in photos.js (window.ApexPhotos).
   Everything talks to /api/admin/* (Cloudflare Access + the Worker's own check). */
(function () {
  "use strict";
  var main = document.getElementById("main"), sheetRoot = document.getElementById("sheetRoot");
  var TABS = ["today", "schedule", "jobs", "people", "money", "settings"];
  var S = { tab: "today", weekFrom: null, jobScope: "upcoming", people: "customers", q: "", archived: false, detail: null, depth: 0 };
  var WEEK_RULES = {}, PCACHE = {}, CUSTS = null;
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], DOWL = ["S", "M", "T", "W", "T", "F", "S"];
  var SIZES = ["Sedan", "SUV", "Truck"], PKG = { exterior: "Exterior", interior: "Interior", full: "Full Detail", custom: "Custom" };
  var ADDN = { pet: "Heavy pet hair", stain: "Heavy stain or odor", lights: "Headlight restoration", engine: "Engine bay" };
  var ADDPK = { pet: ["interior", "full"], stain: ["interior", "full"], lights: ["exterior", "full"], engine: ["exterior", "full"] };
  var STATE = { scheduled: "Scheduled", in_progress: "In progress", done: "Done", paid: "Paid", cancelled: "Cancelled" };
  var MSTATUS = { active: ["Active", "good"], pending: ["Starts soon", ""], past_due: ["Payment failed", "bad"], paused: ["Paused", "warn"], ending: ["Ending", "warn"], cancelled: ["Cancelled", ""] };
  var PLANN = { wash: "Wash", int: "Interior", both: "Wash + interior" }, FREQN = { 1: "Monthly", 2: "Every 2 weeks", 4: "Weekly" };
  var QUICK_NOTES = ["Gate code", "Dog in yard", "Park on street", "Call when outside"];

  // ---------- helpers ----------
  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function svg(p) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + "</svg>"; }
  var IC = {
    phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
    msg: svg('<path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.2A8 8 0 1 1 21 12z"/>'),
    mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
    map: svg('<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>'),
    cam: svg('<path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>'),
    car: svg('<path d="M5 16l1.5-5A2 2 0 0 1 8.4 9.5h7.2a2 2 0 0 1 1.9 1.5L19 16"/><rect x="3" y="16" width="18" height="4" rx="1.5"/><circle cx="7.5" cy="18" r=".6"/><circle cx="16.5" cy="18" r=".6"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>')
  };
  window.ApexIC = IC;
  function api(path, opts) {
    opts = opts || {};
    var o = { method: opts.method || "GET", headers: { "Content-Type": "application/json" }, credentials: "same-origin", redirect: "manual" };
    if (opts.body !== undefined) o.body = JSON.stringify(opts.body);
    return fetch("/api/admin" + path, o).then(function (r) {
      if (r.type === "opaqueredirect" || r.status === 0) { needSignIn(); throw new Error("Your sign-in expired. Tap \"Sign in again\" at the top."); }
      offline(!!r.headers.get("X-Apex-Cache"));
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 403 && j.error === "Not allowed") { needSignIn(); }
        if (!r.ok) { var e = new Error(j.error || ("Something went wrong (" + r.status + ").")); e.status = r.status; e.data = j; throw e; }
        return j;
      });
    }, function () {
      if (!navigator.onLine) offline(true);
      throw new Error(navigator.onLine ? "Couldn't reach the server. Check your signal and try again." : "You're offline. Try again when you have signal.");
    });
  }
  function post(path, body) { return api(path, { method: "POST", body: body || {} }); }
  function del(path) { return api(path, { method: "DELETE" }); }
  function tmin(m) { if (m == null) return ""; m = Math.round(m); var h = Math.floor(m / 60) % 24, mm = m % 60, ap = h >= 12 ? "PM" : "AM", h12 = h % 12 || 12; return h12 + (mm ? ":" + String(mm).padStart(2, "0") : "") + " " + ap; }
  function tshort(m) { var h = Math.floor(m / 60) % 24, ap = h >= 12 ? "p" : "a"; return (h % 12 || 12) + ap; }
  function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
  function fromHHMM(s) { var p = String(s || "").split(":"); return p.length === 2 ? +p[0] * 60 + +p[1] : null; }
  function dkey(d) { return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0"); }
  function pday(k) { var p = k.split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12)); }
  function addD(k, n) { var d = pday(k); d.setUTCDate(d.getUTCDate() + n); return dkey(d); }
  function dlabel(k, long) { return pday(k).toLocaleDateString("en-US", { timeZone: "UTC", weekday: long ? "long" : "short", month: "short", day: "numeric" }); }
  function todayNY() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
  function nowMinNY() { var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date()); var o = {}; p.forEach(function (x) { o[x.type] = x.value; }); return +o.hour * 60 + +o.minute; }
  function whenUtc(ms) { var d = new Date(ms); return d.toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }); }
  function timeUtc(ms) { return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }); }
  function dateUtc(ms, y) { return new Date(ms).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: y ? "numeric" : undefined }); }
  function money(n) { n = +n || 0; return "$" + n.toLocaleString("en-US", { minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 }); }
  function taxOf(d) { var c = Math.round(d * 100); return c > 0 ? Math.floor((c * 6625 + 50000) / 100000) / 100 : 0; }
  function ago(ms) { var s = (Date.now() - ms) / 1000; if (s < 90) return "just now"; if (s < 3600) return Math.round(s / 60) + " min ago"; if (s < 86400) return Math.round(s / 3600) + " hr ago"; return Math.round(s / 86400) + " days ago"; }
  function weekStart(k) { var d = pday(k); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return dkey(d); }
  function hrs(m) { var h = Math.floor(m / 60), r = m % 60; return (h ? h + " hr" : "") + (r ? (h ? " " : "") + r + " min" : ""); }
  function tel(p) { return String(p || "").replace(/[^\d+]/g, ""); }
  function toast(msg, long) { var t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, long ? 6000 : 2800); }
  function buzz() { try { if (navigator.vibrate) navigator.vibrate(12); else { var l = document.getElementById("hapt"); if (l) l.click(); } } catch (e) {} }
  function loading() { main.innerHTML = '<p class="empty">Loading…</p>'; }
  function fail(e) { main.innerHTML = (S.detail ? backBtn() : "") + '<div class="card"><p class="err">' + esc(e.message) + '</p><div class="acts"><button class="btn g sm" data-reload>Try again</button></div></div>'; }
  function stBadge(s) { var x = MSTATUS[s] || [s, ""]; return '<span class="badge ' + x[1] + '">' + esc(x[0]) + "</span>"; }
  function stateBadge(st) { return '<span class="badge st ' + st + '">' + esc(STATE[st] || st) + "</span>"; }
  function kv(k, v, raw) { return '<div class="kv"><span>' + esc(k) + "</span><b>" + (raw ? v : esc(v)) + "</b></div>"; }
  function busy(b, label) { if (!b) return function () {}; var t = b.innerHTML; b.disabled = true; if (label) b.textContent = label; return function () { b.disabled = false; b.innerHTML = t; }; }
  function photoUrl(id, thumb) { return "/api/admin/photos/" + encodeURIComponent(id) + (thumb ? "?t=1" : ""); }
  function thumbHTML(j) { return j.thumb ? '<img class="thumb" src="' + photoUrl(j.thumb, true) + '" alt="" loading="lazy">' : '<span class="thumb ph">' + IC.car + "</span>"; }
  function copy(text) { (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { toast("Copied"); }, function () { prompt("Copy this:", text); }); }

  // ---------- banners: signed out / offline ----------
  var BN = { signin: false, offline: false };
  function needSignIn() { BN.signin = true; banner(); }
  function offline(on) { if (BN.offline !== on) { BN.offline = on; banner(); } }
  function banner() {
    var el = document.getElementById("bnr");
    if (BN.signin) { el.hidden = false; el.innerHTML = '<span>Your sign-in expired.</span><button class="btn sm" data-signin>Sign in again</button>'; }
    else if (BN.offline) { el.hidden = false; el.innerHTML = "<span>No signal. Showing what was saved; changes need signal. Photos keep saving on this phone.</span>"; }
    else el.hidden = true;
  }
  window.addEventListener("online", function () { offline(false); });
  window.addEventListener("offline", function () { offline(true); });

  // ---------- sheets (bottom panels) ----------
  var SH = { dirty: false, ret: null };
  function openSheet(title, inner, opts) {
    opts = opts || {};
    SH = { dirty: false, ret: document.activeElement, guard: opts.guard !== false };
    sheetRoot.innerHTML = '<div class="sheet-bg" data-sheetbg><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="row" style="margin-bottom:14px"><h3>' + esc(title) + '</h3><button class="btn g sm" data-close>' + esc(opts.close || "Cancel") + "</button></div>" + inner + "</div></div>";
    document.body.classList.add("lock");
    if (window.matchMedia("(min-width: 700px)").matches) { var f = sheetRoot.querySelector(".sheet input:not([type=hidden]), .sheet select, .sheet textarea"); if (f && opts.focus !== false) setTimeout(function () { f.focus(); }, 40); }
    return sheetRoot.querySelector(".sheet");
  }
  function closeSheet(force) {
    if (!sheetRoot.innerHTML) return true;
    if (!force && SH.guard && SH.dirty && !confirm("Discard your changes?")) return false;
    sheetRoot.innerHTML = ""; document.body.classList.remove("lock");
    if (SH.ret && document.contains(SH.ret)) try { SH.ret.focus(); } catch (e) {}
    return true;
  }
  sheetRoot.addEventListener("input", function () { SH.dirty = true; });
  sheetRoot.addEventListener("change", function () { SH.dirty = true; });
  function sheetErr(msg) { var e = sheetRoot.querySelector(".err[data-err]"); if (e) { e.textContent = msg; e.hidden = !msg; if (msg) e.scrollIntoView({ block: "nearest" }); } else if (msg) toast(msg, true); }

  // ---------- routing ----------
  function setTabs(tab) {
    S.tab = tab;
    [].forEach.call(document.querySelectorAll(".tabs button"), function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === tab)); b.tabIndex = b.dataset.tab === tab ? 0 : -1; });
  }
  var RENDER = {};
  function route() {
    closeSheet(true);
    window.dispatchEvent(new CustomEvent("apex:route"));
    var h = decodeURIComponent((location.hash || "#today").slice(1)), m;
    if ((m = h.match(/^job\/([A-Z0-9]{4,8})$/))) { S.detail = { type: "job", id: m[1] }; setTabs("jobs"); window.scrollTo(0, 0); return renderJob(m[1]); }
    if ((m = h.match(/^customer\/([a-f0-9]{18})$/))) { S.detail = { type: "customer", id: m[1] }; setTabs("people"); window.scrollTo(0, 0); return renderCustomer(m[1]); }
    if ((m = h.match(/^member\/([a-f0-9]{18})$/))) { S.detail = { type: "member", id: m[1] }; setTabs("people"); window.scrollTo(0, 0); return renderMember(m[1]); }
    S.detail = null;
    var tab = TABS.indexOf(h) > -1 ? h : "today"; setTabs(tab); window.scrollTo(0, 0); RENDER[tab]();
  }
  function go(hash) { S.depth++; if (location.hash === hash) route(); else location.hash = hash; }
  function goBack() { if (S.depth > 0) { S.depth--; history.back(); } else location.hash = "#" + S.tab; }
  function backBtn(label) { return '<button class="back" data-back>' + IC.back.replace("<svg", '<svg style="width:18px;height:18px"') + esc(label || "Back") + "</button>"; }
  function refresh() { if (S.detail) route(); else RENDER[S.tab](); }
  window.ApexApp = { api: api, post: post, esc: esc, toast: toast, buzz: buzz, refresh: refresh, openSheet: openSheet, closeSheet: closeSheet, photoUrl: photoUrl, money: money, copy: copy, sheetErr: sheetErr, dlabel: dlabel };

  function syncLine(s) {
    var el = document.getElementById("sync");
    if (!s) { el.textContent = "Calendar not synced yet"; return; }
    el.innerHTML = "Calendar synced " + esc(ago(s.at)) + ' · <button class="lnk" data-sync style="padding:0">Sync now</button>';
  }

  // ---------- job cards ----------
  function jobBadges(j) {
    var b = [stateBadge(j.state)];
    if (j.kind === "member") b.push('<span class="badge block">Member</span>');
    if (j.paid && j.kind !== "member" && j.state !== "paid" && j.status !== "cancelled") b.push('<span class="badge good">Prepaid</span>');
    if (!j.acked && j.status !== "cancelled" && j.end_utc > Date.now()) b.push('<span class="badge warn">New</span>');
    if (j.status !== "cancelled" && j.kind !== "member" && !j.paid && (j.state === "done" || j.end_utc < Date.now())) b.push('<span class="badge bad">Not paid</span>');
    return b.join("");
  }
  function jobCard(j) {
    return '<div class="card tap" data-href="#job/' + esc(j.id) + '" role="link" tabindex="0" aria-label="' + esc(j.what + ", " + j.name + ", " + whenUtc(j.start_utc)) + '"><div class="jrow">' + thumbHTML(j) +
      '<div class="jm"><div style="font-weight:650">' + esc(whenUtc(j.start_utc)) + "–" + esc(timeUtc(j.end_utc)) + "</div>" +
      "<div>" + esc(j.what) + (j.size != null ? " · " + esc(SIZES[j.size] || "") : "") + (j.quote != null && j.kind !== "member" && !j.paid ? ' <span class="muted small">est. ' + money(j.quote) + " + tax</span>" : "") + "</div>" +
      '<div class="muted small">' + esc(j.name) + (j.town ? " · " + esc(j.town) : "") + (j.car ? " · " + esc(j.car) : "") + (j.photos ? " · " + j.photos + " photo" + (j.photos > 1 ? "s" : "") : "") + "</div></div>" +
      '<div class="jb">' + jobBadges(j) + "</div></div></div>";
  }

  // ---------- Today ----------
  function taxCard(q, link) {
    return '<div class="card taxc"><div class="row"><div><div class="k">NJ sales tax to set aside</div><div class="v">' + money(q.tax) + "</div>" +
      '<div class="s">' + esc(q.label) + (q.filed ? " · filed " + esc(new Date(q.filed).toLocaleDateString("en-US", { month: "short", day: "numeric" })) : " · file and pay by " + esc(dlabel(q.due))) + "</div></div>" +
      (link ? '<button class="btn g sm" data-go="money">Details</button>' : "") + "</div></div>";
  }
  RENDER.today = function () {
    loading();
    api("/home").then(function (d) {
      syncLine(d.sync);
      var h = "<h1>" + esc(dlabel(todayNY(), true)) + '</h1><p class="sub">Here\'s what\'s coming up.</p>';
      var att = [];
      if (d.unacked) att.push('<div class="row"><span>' + d.unacked + " new booking" + (d.unacked > 1 ? "s" : "") + ' you haven\'t opened</span><button class="btn g sm" data-go="jobs">View</button></div>');
      if (d.unpaid.length) att.push('<div class="row"><span>' + d.unpaid.length + " finished job" + (d.unpaid.length > 1 ? "s" : "") + ' not marked paid</span><button class="btn g sm" data-go="money">View</button></div>');
      if (d.pastDue) att.push('<div class="row"><span>' + d.pastDue + " member" + (d.pastDue > 1 ? "s" : "") + ' with a failed payment</span><button class="btn g sm" data-go="people" data-people="members">View</button></div>');
      var qn = window.ApexPhotos ? window.ApexPhotos.pendingCount() : 0;
      if (qn) att.push('<div class="row"><span>' + qn + " photo" + (qn > 1 ? "s" : "") + " saved on this phone, waiting to upload</span></div>");
      if (att.length) h += '<div class="card" style="box-shadow:inset 0 0 0 1px rgba(255,210,122,.35);margin-bottom:14px"><div style="font-weight:650;margin-bottom:8px;color:var(--warn)">Needs you</div>' + att.join("") + "</div>";
      h += '<div class="acts" style="margin:0"><button class="btn" data-newjob>+ Book a job</button><button class="btn g" data-newblock>Block off time</button><button class="btn g" data-go="schedule">My week</button></div>';
      h += "<h2>Next up</h2>" + (d.next.length ? '<div class="list">' + d.next.map(jobCard).join("") + "</div>" : '<div class="card empty">No upcoming jobs yet.</div>');
      if (!d.storage) h += '<p class="note" style="margin-top:10px">Photo storage (Cloudflare R2) isn\'t turned on yet. Photos you take are kept on this phone until it is.</p>';
      h += '<h2>This month</h2><div class="grid2">' +
        '<div class="card stat"><div class="k">Details paid</div><div class="v">' + money(d.month.details) + '</div><div class="s">' + d.month.jobs + " job" + (d.month.jobs === 1 ? "" : "s") + "</div></div>" +
        '<div class="card stat"><div class="k">Tips</div><div class="v">' + money(d.month.tips) + "</div></div>" +
        '<div class="card stat"><div class="k">Memberships</div><div class="v">' + money(d.month.members) + '</div><div class="s">charged this month</div></div>' +
        '<div class="card stat tap" data-go="people" data-people="members"><div class="k">Members</div><div class="v">' + d.members.count + '</div><div class="s">' + money(d.members.monthly) + "/mo + tax</div></div></div>";
      if (d.taxQuarter) h += taxCard(d.taxQuarter, true);
      main.innerHTML = h;
    }).catch(fail);
  };

  // ---------- Schedule ----------
  var BAR0 = 7 * 60, BAR1 = 20 * 60;
  function pct(m) { return Math.max(0, Math.min(100, (m - BAR0) / (BAR1 - BAR0) * 100)); }
  function seg(cls, a, b, title) { if (b <= BAR0 || a >= BAR1) return ""; return '<i class="' + cls + '" style="left:' + pct(a) + "%;width:" + (pct(b) - pct(a)) + '%"' + (title ? ' title="' + esc(title) + '"' : "") + "></i>"; }
  RENDER.schedule = function () {
    if (!S.weekFrom) S.weekFrom = weekStart(todayNY());
    loading();
    Promise.all([api("/week?from=" + S.weekFrom + "&n=7"), api("/blockouts")]).then(function (r) {
      var w = r[0], bl = r[1].blockouts, today = todayNY(); WEEK_RULES = w.rules || {};
      var h = '<h1>Schedule</h1><p class="sub">Your calendar, blocked time and jobs. Green is open for bookings (already includes the buffers). “Fits” uses sedan times.</p>';
      h += '<div class="weeknav"><button class="btn g sm" data-week="-7" aria-label="Previous week">‹ Prev</button><span class="lbl">' + esc(dlabel(w.from)) + " – " + esc(dlabel(addD(w.from, 6))) + '</span><button class="btn g sm" data-week="7" aria-label="Next week">Next ›</button></div>';
      h += '<div class="acts" style="margin:-4px 0 14px"><button class="btn sm" data-newjob>+ Book a job</button><button class="btn g sm" data-newblock>+ Block off time</button>' + (w.from !== weekStart(today) ? '<button class="btn g sm" data-week="0">This week</button>' : "") + "</div>";
      h += '<div class="legend"><span><i style="width:10px;height:10px;border-radius:3px;background:rgba(143,227,165,.5);display:inline-block"></i>Open</span><span><i style="width:10px;height:10px;border-radius:3px;background:#ededed;display:inline-block"></i>Job</span><span><i style="width:10px;height:10px;border-radius:3px;background:rgba(255,255,255,.35);display:inline-block"></i>Calendar</span><span><i style="width:10px;height:10px;border-radius:3px;background:var(--block);display:inline-block"></i>Blocked</span></div>';
      h += '<div class="list">' + w.days.map(function (d) { return dayCard(d, today); }).join("") + "</div>";
      h += "<h2>Your blocked time</h2>";
      h += bl.length ? '<div class="list">' + bl.map(blockCard).join("") + "</div>" : '<div class="card empty">Nothing blocked yet. Use “Block off time” for classes, appointments or days you don\'t want jobs.</div>';
      main.innerHTML = h;
    }).catch(fail);
  };
  function dayCard(d, today) {
    var segs = "", items = "";
    segs += seg("dark", BAR0, 8 * 60, "") + seg("dark", d.end, BAR1, "After cutoff");
    d.free.forEach(function (f) { segs += seg("free", f[0], f[1], "Open " + tmin(f[0]) + "–" + tmin(f[1])); });
    d.items.forEach(function (it) {
      if (it.allDay) { if (it.type === "block" || it.type === "calblock") segs += seg("block", BAR0, BAR1, it.title || "Blocked"); return; }
      segs += seg(it.type === "job" || it.type === "caljob" ? "job" : it.type === "block" || it.type === "calblock" ? "block" : "event", it.start, it.end, "");
    });
    d.items.forEach(function (it) {
      var t = it.allDay ? "All day" : tmin(it.start) + "–" + tmin(it.end), label, dot, x = "";
      if (it.type === "event") { if (it.allDay) return; label = '<span class="muted">Busy (your calendar)</span>'; dot = "event"; }
      else if (it.type === "caljob") { label = "Apex Jobs calendar event"; dot = "job"; }
      else if (it.type === "calblock") { label = "Blocked (calendar)"; dot = "block"; }
      else if (it.type === "block") { label = esc(it.title || "Blocked") + (it.repeat === "weekly" ? ' <span class="dim small">weekly</span>' : ""); dot = "block";
        if (!d.past) x = '<span class="x"><button class="lnk" data-skip="' + esc(it.id) + '" data-day="' + d.day + '" data-weekly="' + (it.repeat === "weekly" ? 1 : 0) + '">' + (it.repeat === "weekly" ? "Skip this day" : "Remove") + "</button></span>"; }
      else { label = "<b>" + esc(it.what) + "</b> · " + esc(it.name) + (it.town ? " · " + esc(it.town) : ""); dot = "job"; x = '<span class="x"><button class="lnk" data-href="#job/' + esc(it.id) + '">Open</button></span>'; }
      items += '<div class="it"><i class="dot ' + dot + '"></i><span class="t">' + esc(t) + "</span><span>" + label + "</span>" + x + "</div>";
    });
    if (!d.past) d.free.forEach(function (f) { items += '<div class="it"><i class="dot free"></i><span class="t">' + tmin(f[0]) + "–" + tmin(f[1]) + '</span><span class="muted">' + fits(f[1] - f[0], d.winter) + '</span><span class="x"><button class="lnk" data-newjob data-day="' + d.day + '" data-start="' + f[0] + '">Book</button></span></div>'; });
    var meta = [];
    if (d.winter) meta.push('<span class="badge">Interior only</span>');
    if (d.jobs >= d.maxJobs) meta.push('<span class="badge">Booked</span>');
    else if (d.off) meta.push('<span class="badge good">Day off · up to ' + d.maxJobs + " jobs</span>");
    meta.push('<span class="dim small">Done by ' + tmin(d.end) + "</span>");
    var ticks = ""; for (var m = 8 * 60; m <= 19 * 60; m += 120) ticks += '<span style="left:' + pct(m) + '%">' + tshort(m) + "</span>";
    return '<div class="card day' + (d.day === today ? " today" : "") + (d.past ? " past" : "") + '"><div class="dhead"><b>' + esc(dlabel(d.day, true)) + (d.day === today ? " · Today" : "") + '</b><span class="dmeta">' + meta.join("") + "</span></div>" +
      '<div class="bar">' + segs + '</div><div class="ticks">' + ticks + "</div>" +
      (items ? '<div class="items">' + items + "</div>" : '<p class="dim small" style="margin-top:6px">Nothing scheduled.</p>') + "</div>";
  }
  function fits(len, winter) {
    var L = WEEK_RULES.baseMin || { exterior: [90], interior: [210], full: [300] };
    if (winter) return len >= L.interior[0] ? "Open · fits an Interior" : "Open · too short for an Interior";
    if (len >= L.full[0]) return "Open · fits any detail";
    if (len >= L.interior[0]) return "Open · fits Interior or Exterior";
    if (len >= L.exterior[0]) return "Open · fits an Exterior";
    return "Open · too short for a detail";
  }
  function blockCard(b) {
    var when = b.start_min == null ? "All day" : tmin(b.start_min) + "–" + tmin(b.end_min), what;
    if (b.repeat === "weekly") what = "Every " + b.weekdays.split(",").map(function (n) { return DOW[+n]; }).join(", ") + " · " + when + '<div class="dim small">From ' + esc(dlabel(b.from_day)) + (b.until_day ? " to " + esc(dlabel(b.until_day)) : ", no end date") + (b.skip_days.length ? " · skipping " + b.skip_days.length + " day" + (b.skip_days.length > 1 ? "s" : "") : "") + "</div>";
    else what = esc(dlabel(b.day, true)) + " · " + when;
    return '<div class="card"><div class="row"><div><div style="font-weight:650">' + esc(b.title) + '</div><div class="muted small">' + what + '</div></div><button class="btn d sm" data-delblock="' + esc(b.id) + '">Delete</button></div></div>';
  }
  function openBlockSheet(day) {
    var d0 = day || todayNY();
    openSheet("Block off time", '<p class="sub" style="margin-top:-6px">Customers can\'t book over this (plus the buffer).</p>' +
      '<form id="bf" class="fg" autocomplete="off"><label class="f">What is it?<input type="text" name="title" placeholder="e.g. Class, Dentist, No jobs" maxlength="60"></label>' +
      '<div class="seg" id="bRep" style="margin:0"><button type="button" data-v="once" aria-pressed="true">One time</button><button type="button" data-v="weekly" aria-pressed="false">Every week</button></div>' +
      '<label class="f" id="bOnce">Date<input type="date" name="day" value="' + d0 + '" min="' + todayNY() + '"></label>' +
      '<div id="bWeekly" hidden class="fg"><div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Days<div class="wd" id="bWd">' + DOWL.map(function (l, i) { return '<button type="button" data-wd="' + i + '" aria-pressed="false" aria-label="' + DOW[i] + '">' + l + "</button>"; }).join("") + "</div></div>" +
      '<div class="fg2"><label class="f">Starting<input type="date" name="from_day" value="' + todayNY() + '"></label><label class="f">Until (optional)<input type="date" name="until_day"></label></div></div>' +
      '<label class="chk"><input type="checkbox" name="allDay" id="bAll"> All day</label>' +
      '<div class="fg2" id="bTimes"><label class="f">From<input type="time" name="start" value="09:00" step="900"></label><label class="f">To<input type="time" name="end" value="12:00" step="900"></label></div>' +
      '<p class="err" data-err hidden></p><button class="btn lg w" type="submit">Save</button></form>');
  }
  function saveBlock(form) {
    var rep = document.querySelector("#bRep [aria-pressed=true]").dataset.v, fd = new FormData(form);
    var body = { title: fd.get("title"), repeat: rep, day: fd.get("day"), from_day: fd.get("from_day"), until_day: fd.get("until_day"), allDay: document.getElementById("bAll").checked, start: fd.get("start"), end: fd.get("end"),
      weekdays: [].map.call(document.querySelectorAll("#bWd [aria-pressed=true]"), function (b) { return +b.dataset.wd; }) };
    var sb = form.querySelector('button[type="submit"]'); if (sb.disabled) return; var done = busy(sb, "Saving…"); sheetErr("");
    post("/blockouts", body).then(function () { closeSheet(true); toast("Blocked off"); if (S.tab === "schedule" && !S.detail) RENDER.schedule(); else go("#schedule"); })
      .catch(function (e) { sheetErr(e.message); done(); });
  }

  // ---------- Jobs ----------
  RENDER.jobs = function () {
    loading();
    api("/jobs?scope=" + S.jobScope).then(function (d) {
      var h = '<div class="row" style="align-items:flex-start"><div><h1>Jobs</h1><p class="sub">Tap a job for photos, status and getting paid.</p></div><button class="btn sm" data-newjob>+ Book a job</button></div>';
      h += '<div class="seg">' + [["upcoming", "Upcoming"], ["past", "Past"], ["cancelled", "Cancelled"]].map(function (s) { return '<button data-scope="' + s[0] + '" aria-pressed="' + (s[0] === S.jobScope) + '">' + s[1] + "</button>"; }).join("") + "</div>";
      h += d.jobs.length ? '<div class="list">' + d.jobs.map(jobCard).join("") + "</div>" : '<div class="card empty">No ' + S.jobScope + " jobs.</div>";
      main.innerHTML = h;
    }).catch(fail);
  };

  // ---------- Job screen ----------
  var JOB = null;
  function renderJob(id) {
    if (!JOB || JOB.id !== id) { loading(); S.payOpen = false; }
    api("/jobs/" + id).then(function (d) { JOB = d.job; drawJob(); if (!JOB.acked && JOB.status === "confirmed") post("/jobs/" + id + "/ack").catch(function () {}); }).catch(fail);
  }
  window.ApexApp.reloadJob = function () { if (S.detail && S.detail.type === "job") renderJob(S.detail.id); };
  window.ApexApp.job = function () { return JOB; };
  function drawJob() {
    var j = JOB, st = j.state, cancelled = j.status === "cancelled", member = j.kind === "member", where = [j.address, j.town].filter(Boolean).join(", ");
    var h = backBtn() + '<div class="row" style="align-items:flex-start"><div style="min-width:0"><h1>' + esc(j.what) + " · " + esc(j.name) + '</h1><p class="sub" style="margin:0">' + esc(whenUtc(j.start_utc)) + "–" + esc(timeUtc(j.end_utc)) + "</p></div>" + stateBadge(st) + "</div>";
    if (!cancelled) {
      var order = member ? ["scheduled", "in_progress", "done"] : ["scheduled", "in_progress", "done", "paid"], at = order.indexOf(st);
      h += '<div class="steps" aria-label="Status: ' + esc(STATE[st]) + '">' + order.map(function (s, i) { return '<span class="' + (i < at ? "on" : i === at ? (s === "paid" || (member && s === "done") ? "on" : "now") : "") + '">' + STATE[s] + "</span>"; }).join("") + "</div>";
    } else h += '<p class="note">Cancelled ' + (j.cancelledAt ? esc(dateUtc(j.cancelledAt)) : "") + (j.cancelReason ? " · " + esc({ customer: "the customer asked", us: "weather or our side", noshow: "no-show", refunded: "refunded in Square" }[j.cancelReason] || "") : "") + "</p>";
    // contact
    var ph = tel(j.phone);
    h += '<div class="contact"><a href="https://maps.apple.com/?daddr=' + encodeURIComponent(where) + '" target="_blank" rel="noopener"' + (where ? "" : ' aria-disabled="true"') + ">" + IC.map + "Directions</a>" +
      '<a href="tel:' + esc(ph) + '"' + (ph ? "" : ' aria-disabled="true"') + ">" + IC.phone + "Call</a>" +
      '<a href="sms:' + esc(ph) + '"' + (ph ? "" : ' aria-disabled="true"') + ">" + IC.msg + "Text</a>" +
      '<a href="mailto:' + esc(j.email || "") + '"' + (j.email ? "" : ' aria-disabled="true"') + ">" + IC.mail + "Email</a></div>";
    // what to do next
    if (!cancelled) {
      var nb = '<div class="acts" style="margin-top:14px">';
      if (st === "scheduled") nb += '<button class="btn lg" data-walk="before" style="flex:1">' + IC.cam + " Start job · before photos</button>";
      else if (st === "in_progress") nb += '<button class="btn lg" data-walk="after" style="flex:1">' + IC.cam + ' After photos</button><button class="btn g lg" data-jobact="done">Mark done</button>';
      else if (st === "done" && !member) nb += '<a class="btn lg" href="#pay" data-scrollpay style="flex:1">Get paid</a>';
      nb += "</div>"; if (nb.indexOf("btn") > -1) h += nb;
    }
    // photos
    h += '<h2 id="photos">Photos' + (j.photos.counts.total ? ' <span class="dim small" style="font-weight:500">· ' + j.photos.counts.before + "/" + j.photos.counts.total + " before · " + j.photos.counts.after + "/" + j.photos.counts.total + " after</span>" : "") + "</h2>";
    h += window.ApexPhotos ? window.ApexPhotos.checklistHTML(j) : '<div class="card empty">Photo tools didn\'t load. Refresh.</div>';
    // get paid
    if (!member && !cancelled) h += st === "scheduled" && !j.paid && !S.payOpen ? '<div class="acts" style="margin-top:14px"><button class="btn g sm" data-payopen>Take payment now</button></div>' : payCard(j);
    if (member && !cancelled) h += '<div class="card" style="margin-top:14px">' + kv("Payment", "Included in their Apex Membership") + (j.membership ? kv("Plan", j.membership.label) : "") +
      (st !== "done" ? '<div class="acts"><button class="btn" data-jobact="done">Mark visit done</button></div>' : '<div class="acts"><button class="btn g sm" data-jobact="not_done">Mark not done</button></div>') + "</div>";
    // details
    h += "<h2>Details</h2><div class=\"card\">" +
      kv("Customer", j.customer ? '<a href="#customer/' + esc(j.customer.id) + '" data-href="#customer/' + esc(j.customer.id) + '">' + esc(j.name) + "</a>" : esc(j.name), true) +
      kv("Package", j.what + " · " + (SIZES[j.size] || "")) + (j.adds && j.adds.length ? kv("Add-ons", j.adds.map(function (a) { return ADDN[a] || a; }).join(", ")) : "") +
      kv("Vehicle", j.vehicle ? esc(j.vehicle.name + (j.vehicle.color ? " · " + j.vehicle.color : "")) + (j.vehicle.plate ? ' <span class="plate">' + esc(j.vehicle.plate) + "</span>" : "") : esc(j.car || "—"), true) +
      kv("Address", where || "—") + (j.miles != null ? kv("Distance", j.miles + " mi" + (j.travel ? " · $" + j.travel + " travel" : "")) : "") +
      (j.kind !== "member" ? kv("Estimate", money(j.estimate.sub) + " + " + money(j.estimate.tax) + " tax = " + money(j.estimate.total)) : "") +
      kv("Water / power", [j.water ? "Spigot: " + j.water : "", j.power ? "Outlet: " + j.power : ""].filter(Boolean).join(" · ") || "—") +
      (j.notes ? kv("Their notes", j.notes) : "") + (j.customer && j.customer.notes ? kv("Customer notes", j.customer.notes) : "") +
      (j.startsMembership ? kv("Starts", "Apex Membership · " + j.startsMembership.label) : "") +
      kv("Booked", (j.owner ? "By you" : "Online") + (j.heard ? " · heard via " + j.heard : "")) + kv("Code", j.id) + "</div>";
    h += '<label class="f" style="margin-top:14px">Your notes (only you see these)<textarea id="jNotes" placeholder="Gate code, condition, what to upsell next time…">' + esc(j.ownerNotes) + "</textarea></label>" +
      '<div class="acts" style="margin-top:8px"><button class="btn g sm" data-savejnotes>Save notes</button></div>';
    // manage
    if (!cancelled) {
      h += "<h2>Change it</h2><div class=\"acts\" style=\"margin-top:0\">";
      if (!j.done) h += '<button class="btn g" data-jmove>Reschedule</button>';
      if (!j.paid) h += '<button class="btn g" data-jedit>Edit details</button>';
      if (st === "in_progress") h += '<button class="btn g" data-jobact="scheduled">Back to scheduled</button>';
      if (st === "scheduled") h += '<button class="btn g" data-jobact="in_progress">Mark in progress</button>';
      if (st === "done" && !member && !j.paid) h += '<button class="btn g" data-jobact="not_done">Mark not done</button>';
      if (member ? !j.done : !j.paid) h += '<button class="btn d" data-jcancel>Cancel job</button>';
      if (!member && j.paid) h += '<button class="btn d" data-jrefund>Refunded in Square</button>';
      h += "</div>";
      h += '<p class="note">Customer link: <button class="lnk" data-copy="' + esc(j.manageLink) + '">copy manage link</button>' + (j.payLink ? ' · <button class="lnk" data-copy="' + esc(j.payLink) + '">copy pay link</button>' : "") + "</p>";
    }
    if (j.canDelete) h += '<div class="acts"><button class="btn d sm" data-jdel>Delete job</button></div>';
    if (j.log && j.log.length) h += '<h2>History</h2><div class="card">' + j.log.map(function (l) { return '<div class="logl"><b>' + esc(dateUtc(l.at)) + " " + esc(timeUtc(l.at)) + "</b>" + esc(l.what) + (l.detail ? ' <span class="dim">(' + esc(l.detail) + ")</span>" : "") + "</div>"; }).join("") + "</div>";
    main.innerHTML = h;
    upPay();
  }
  function payCard(j) {
    var h = '<h2 id="pay">Get paid</h2><div class="card">';
    if (j.paid) {
      h += kv("Paid", money(j.final) + (j.tax ? " + " + money(j.tax) + " tax" : "") + (j.tip ? " + " + money(j.tip) + " tip" : "") + " = " + money(j.final + j.tax + j.tip)) + kv("How", String(j.method || "").replace(/_/g, " ").replace(":", " · ")) + (j.paidAt ? kv("When", whenUtc(j.paidAt)) : "") +
        (j.receipt ? '<div class="acts"><a class="btn g sm" href="' + esc(j.receipt) + '" target="_blank" rel="noopener">Square receipt</a></div>' : "") +
        (/^in_person/.test(j.method || "") ? '<div class="acts"><button class="btn g sm" data-pay="undo">Undo "paid in person"</button></div>' : "");
      return h + "</div>";
    }
    var due = j.final != null ? j.final : j.quote || 0;
    h += '<label class="f" for="amt">Price before tax' + (j.quote ? " (estimate " + money(j.quote) + (j.travel ? ", includes $" + j.travel + " travel" : "") + ")" : "") + '</label><div class="money-in"><span>$</span><input id="amt" inputmode="decimal" value="' + esc(due) + '" autocomplete="off"></div>' +
      kv("NJ sales tax (6.625%)", '<span id="taxAmt"></span>', true) + kv("Customer pays", '<span id="totAmt" style="font-size:19px"></span>', true) +
      (j.final != null && j.payLink ? '<p class="note">A pay link for ' + money(j.final + j.tax) + " was sent. It's waiting on them.</p>" : "") +
      '<div class="menu" style="margin-top:12px">' +
      (j.card && j.squareOn ? '<button class="btn lg" data-pay="charge">Charge ' + esc(j.card) + "</button>" : "") +
      (j.squareOn ? '<button class="btn ' + (j.card ? "g" : "lg") + '" data-pay="link">' + (j.email ? "Email them a pay link" : "Get a pay link to text them") + "</button>" : "") +
      '<button class="btn g" data-pay="inperson" data-how="cash">Paid in person: cash</button><button class="btn g" data-pay="inperson" data-how="card">Paid in person: card / Tap to Pay</button><button class="btn g" data-pay="inperson" data-how="other">Paid in person: Venmo / other</button></div>' +
      '<p class="note">Charging the card or the pay link adds the tax and emails a receipt (with an "Add a tip" button). Paid in person? Collect the "Customer pays" total. Tips aren\'t taxed.</p>';
    return h + "</div>";
  }
  function upPay() {
    var a = document.getElementById("amt"); if (!a) return;
    var c = parseFloat(String(a.value).replace(/[$,]/g, "")) || 0, t = taxOf(c);
    document.getElementById("taxAmt").textContent = money(t); document.getElementById("totAmt").textContent = money(Math.round((c + t) * 100) / 100);
  }
  function doPay(b) {
    var j = JOB, act = b.dataset.pay;
    if (act === "undo") { if (!confirm('Mark this job as not paid again?')) return; return payReq({ action: "undo" }, b); }
    var raw = String(document.getElementById("amt").value).trim(), c = parseFloat(raw.replace(/[$,]/g, ""));
    if (!/^\$?[\d,]+(\.\d{1,2})?$/.test(raw) || !(c >= 1)) return toast("Enter the price before tax, like 179.");
    var tot = document.getElementById("totAmt").textContent, big = false;
    if (j.quote && c > 2 * j.quote) { if (!confirm("That's more than double the " + money(j.quote) + " estimate. Continue with " + tot + "?")) return; big = true; }
    var q = act === "charge" ? "Charge " + tot + " (with tax) to " + j.card + "?" : act === "link" ? (j.email ? "Email " + j.email + " a link to pay " + tot + "?" : "Make a pay link for " + tot + "?") : "Mark paid in person (" + ({ cash: "cash", card: "card / Tap to Pay", other: "Venmo / other" }[b.dataset.how]) + "): " + tot + "?";
    if (!confirm(q)) return;
    payReq({ action: act, amount: raw, how: b.dataset.how, big: big }, b);
  }
  function payReq(body, b) {
    var done = busy(b, "Working…");
    post("/jobs/" + JOB.id + "/pay", body).then(function (r) {
      buzz(); toast(r.msg, true);
      if (r.payLink && !JOB.email) copy(r.payLink);
      renderJob(JOB.id);
    }).catch(function (e) { done(); toast(e.message, true); });
  }

  // ---------- job sheets: book, reschedule, edit, cancel ----------
  function loadCustomers() { return CUSTS ? Promise.resolve(CUSTS) : api("/customers").then(function (d) { CUSTS = d.customers; return CUSTS; }); }
  var BK = null;
  function openBook(pre) {
    pre = pre || {};
    BK = { customer: null, vehicles: [], vehicleId: "", pkg: "full", size: 0, adds: [], day: pre.day || addD(todayNY(), 1), start: pre.start != null ? +pre.start : null, anyTime: false, preview: null, newCust: false, newVeh: false };
    var sh = openSheet("Book a job", '<form id="bkf" class="fg" autocomplete="off">' +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Customer<div id="bkCust"></div></div>' +
      '<div id="bkVehBox" class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)" hidden>Vehicle<select id="bkVeh"></select><div id="bkNewVeh" class="fg" hidden>' + vehFields({}) + "</div></div>" +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Package<div class="pills" id="bkPkg">' + ["exterior", "interior", "full", "custom"].map(function (k) { return '<button type="button" data-v="' + k + '" aria-pressed="' + (k === "full") + '">' + PKG[k] + "</button>"; }).join("") + "</div></div>" +
      '<div id="bkCustom" class="fg2" hidden><label class="f">Package name<input type="text" id="bkCname" maxlength="40" placeholder="e.g. Ceramic coating"></label><label class="f">Length<select id="bkDur">' + [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480].map(function (m) { return '<option value="' + m + '"' + (m === 120 ? " selected" : "") + ">" + hrs(m) + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Size<div class="pills" id="bkSize">' + SIZES.map(function (s, i) { return '<button type="button" data-v="' + i + '" aria-pressed="' + (i === 0) + '">' + s + "</button>"; }).join("") + "</div></div>" +
      '<div id="bkAdds" class="fg" style="gap:8px"></div>' +
      '<label class="f">Date<input type="date" id="bkDay" value="' + BK.day + '"></label>' +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Time<div id="bkTimes" class="pills"><span class="dim small">Pick a customer and package first.</span></div>' +
      '<label class="chk" style="font-size:14px;color:var(--fg)"><input type="checkbox" id="bkAny"> Any time (ignore my calendar)</label><input type="time" id="bkAt" step="900" hidden value="' + (BK.start != null ? hhmm(BK.start) : "09:00") + '"></div>' +
      '<div class="card" id="bkPrice" style="padding:10px 14px"><span class="dim small">Price shows once a customer is picked.</span></div>' +
      '<label class="f">Price before tax (leave empty to use the estimate)<input type="number" id="bkOver" inputmode="decimal" min="0" max="5000" step="1" placeholder="Estimate"></label>' +
      '<div id="bkPayBox" hidden class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Payment<div class="pills" id="bkPay"><button type="button" data-v="later" aria-pressed="true">Pay after the job</button><button type="button" data-v="card" aria-pressed="false" id="bkCardBtn">Card on file</button></div></div>' +
      '<label class="f">Job notes (address details, what they want)<textarea id="bkNotes" maxlength="1500"></textarea></label>' +
      '<label class="f">Your private notes<textarea id="bkOwn" maxlength="2000" style="min-height:60px"></textarea></label>' +
      '<label class="chk" id="bkNotifyRow"><input type="checkbox" id="bkNotify" checked> Email the customer a confirmation</label>' +
      '<p class="err" data-err hidden></p><button class="btn lg w" type="submit">Book it</button></form>');
    drawBookCustomer(pre.customerId);
    drawAdds();
    return sh;
  }
  function vehFields(v) {
    return '<div class="fg3"><label class="f">Year<input type="text" inputmode="numeric" name="year" maxlength="4" value="' + esc(v.year || "") + '"></label><label class="f">Make<input type="text" name="make" maxlength="30" value="' + esc(v.make || "") + '" placeholder="Toyota"></label><label class="f">Model<input type="text" name="model" maxlength="40" value="' + esc(v.model || "") + '" placeholder="RAV4"></label></div>' +
      '<div class="fg3"><label class="f">Color<input type="text" name="color" maxlength="30" value="' + esc(v.color || "") + '"></label><label class="f">Plate<input type="text" name="plate" maxlength="12" value="' + esc(v.plate || "") + '" style="text-transform:uppercase" autocapitalize="characters"></label><label class="f">Size<select name="size"><option value="">—</option>' + SIZES.map(function (s, i) { return '<option value="' + i + '"' + (v.size === i ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></label></div>";
  }
  function readVeh(root) { var g = function (n) { var el = root.querySelector('[name="' + n + '"]'); return el ? el.value : ""; }; return { year: g("year"), make: g("make"), model: g("model"), color: g("color"), plate: g("plate").toUpperCase(), size: g("size"), notes: g("notes") }; }
  function drawBookCustomer(cid) {
    var box = document.getElementById("bkCust"); if (!box) return;
    if (BK.customer) {
      var c = BK.customer;
      box.innerHTML = '<div class="row card" style="padding:10px 12px"><div class="jrow"><span class="avatar" style="width:36px;height:36px;font-size:13px">' + esc(c.initials) + '</span><div><b>' + esc(c.name) + '</b><div class="dim small">' + esc([c.phone, c.email, c.town].filter(Boolean).join(" · ")) + '</div></div></div><button type="button" class="btn g sm" data-bkchange>Change</button></div>';
      return;
    }
    if (BK.newCust) {
      box.innerHTML = '<div class="fg" id="bkNC"><input type="text" name="name" placeholder="Name (required)" maxlength="80"><div class="fg2"><input type="tel" name="phone" placeholder="Phone" maxlength="30"><input type="email" name="email" placeholder="Email (optional)" maxlength="120"></div><div class="fg2"><input type="text" name="address" placeholder="Street address" maxlength="160"><input type="text" name="town" placeholder="Town" maxlength="60"></div><button type="button" class="btn g sm" data-bkfind style="justify-self:start">Search existing instead</button></div>';
      BK.vehicles = []; drawVehicles(); refreshPreview(); return;
    }
    box.innerHTML = '<input type="search" id="bkQ" placeholder="Search name, phone or email" autocomplete="off"><div id="bkRes" class="menu" style="margin-top:6px"></div><button type="button" class="btn g sm" data-bknew style="justify-self:start;margin-top:4px">+ New customer</button>';
    loadCustomers().then(function (list) {
      if (cid) { var c = list.filter(function (x) { return x.id === cid; })[0]; if (c) return pickCustomer(c); }
      drawResults("");
    });
  }
  function drawResults(q) {
    var el = document.getElementById("bkRes"); if (!el || !CUSTS) return; q = q.toLowerCase().trim();
    var list = CUSTS.filter(function (c) { return !q || [c.name, c.email, c.phone, tel(c.phone), c.vehicle].join(" ").toLowerCase().indexOf(q) > -1; }).slice(0, q ? 8 : 5);
    el.innerHTML = list.map(function (c) { return '<button type="button" class="btn g" data-bkpick="' + esc(c.id) + '" style="justify-content:flex-start;text-align:left;min-height:48px"><span class="avatar" style="width:30px;height:30px;font-size:12px">' + esc(c.initials) + "</span>" + esc(c.name || c.email || "Customer") + ' <span class="dim small" style="font-weight:500">' + esc(c.vehicle || c.town || "") + "</span></button>"; }).join("") || '<p class="dim small">No match. Add them as a new customer.</p>';
  }
  function pickCustomer(c) {
    BK.customer = c; BK.newCust = false; drawBookCustomer();
    api("/customers/" + c.id).then(function (d) {
      BK.vehicles = d.vehicles; BK.full = d.customer; drawVehicles();
      var pb = document.getElementById("bkPayBox"); pb.hidden = !d.customer.card; if (d.customer.card) document.getElementById("bkCardBtn").textContent = "Card on file (" + d.customer.card + ")";
      var nr = document.getElementById("bkNotifyRow"); nr.hidden = !d.customer.email;
      refreshPreview();
    });
  }
  function drawVehicles() {
    var box = document.getElementById("bkVehBox"), sel = document.getElementById("bkVeh"); if (!box) return;
    box.hidden = !(BK.customer || BK.newCust);
    sel.innerHTML = BK.vehicles.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name + (v.color ? " · " + v.color : "") + (v.plate ? " · " + v.plate : "")) + "</option>"; }).join("") + '<option value="">No vehicle</option><option value="new">+ New vehicle</option>';
    if (!BK.vehicles.length) sel.value = BK.newCust ? "new" : "";
    BK.vehicleId = sel.value; document.getElementById("bkNewVeh").hidden = sel.value !== "new";
    var v = BK.vehicles.filter(function (x) { return x.id === sel.value; })[0]; if (v && v.size != null) setPill("bkSize", String(v.size));
  }
  function setPill(id, val) { var g = document.getElementById(id); if (!g) return; [].forEach.call(g.children, function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === val)); }); if (id === "bkSize") BK.size = +val; if (id === "bkPkg") BK.pkg = val; }
  function drawAdds() {
    var el = document.getElementById("bkAdds"); if (!el) return;
    var ok = BK.pkg === "custom" ? [] : Object.keys(ADDN).filter(function (a) { return ADDPK[a].indexOf(BK.pkg) > -1; });
    BK.adds = BK.adds.filter(function (a) { return ok.indexOf(a) > -1; });
    el.innerHTML = ok.length ? '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Add-ons<div class="pills" id="bkAddP">' + ok.map(function (a) { return '<button type="button" data-v="' + a + '" aria-pressed="' + (BK.adds.indexOf(a) > -1) + '">' + ADDN[a] + "</button>"; }).join("") + "</div></div>" : "";
    document.getElementById("bkCustom").hidden = BK.pkg !== "custom";
  }
  var prevT = null;
  function refreshPreview() {
    clearTimeout(prevT); prevT = setTimeout(function () {
      if (!document.getElementById("bkf")) return;
      var body = { customerId: BK.customer ? BK.customer.id : null, pkg: BK.pkg, size: BK.size, adds: BK.adds, day: document.getElementById("bkDay").value, town: BK.newCust ? (sheetRoot.querySelector('#bkNC [name="town"]') || {}).value : undefined };
      if (BK.pkg === "custom") body.durationMin = +document.getElementById("bkDur").value;
      post("/jobs/preview", body).then(function (p) {
        BK.preview = p; var t = document.getElementById("bkTimes"), pr = document.getElementById("bkPrice"); if (!t) return;
        var d = p.day;
        if (!d) t.innerHTML = '<span class="dim small">Pick a date.</span>';
        else if (!d.times.length) t.innerHTML = '<span class="dim small">' + ({ past: "That day has passed.", full: "That day already has the most jobs you take. Use “Any time” to add one anyway.", busy: "No open time long enough (" + hrs(p.duration) + ") that day. Use “Any time” to book anyway." }[d.reason] || "No open times.") + "</span>";
        else { if (BK.start == null || d.times.indexOf(BK.start) < 0) BK.start = d.times[0]; t.innerHTML = d.times.map(function (m) { return '<button type="button" data-v="' + m + '" aria-pressed="' + (m === BK.start) + '">' + tmin(m) + "</button>"; }).join(""); }
        if (d && d.winter && BK.pkg !== "interior") t.insertAdjacentHTML("beforeend", '<span class="dim small" style="width:100%">Winter: customers can only book Interior online. You can still add this one.</span>');
        if (p.price) { var q = p.price; pr.innerHTML = kv("Estimate", money(q.subtotal) + " + " + money(q.tax) + " tax = " + money(q.total)) + '<div class="dim small">' + [q.launch ? "Launch price (first detail)" : q.returning ? "Regular price (returning customer)" : "", q.member ? "member add-on discount" : "", q.travel ? "includes $" + q.travel + " travel (" + q.miles + " mi)" : q.miles != null ? q.miles + " mi" : "", q.tooFar ? "outside your usual area" : "", hrs(p.duration)].filter(Boolean).join(" · ") + "</div>"; document.getElementById("bkOver").placeholder = String(q.subtotal); }
        else pr.innerHTML = '<span class="dim small">' + (BK.pkg === "custom" ? "Custom package: enter the price below." : "Pick a customer to see the price.") + " · " + hrs(p.duration) + "</span>";
      }).catch(function (e) { sheetErr(e.message); });
    }, 120);
  }
  function submitBook(form) {
    var sb = form.querySelector('[type="submit"]'); if (sb.disabled) return; sheetErr("");
    var any = document.getElementById("bkAny").checked, start = any ? fromHHMM(document.getElementById("bkAt").value) : BK.start;
    if (!BK.customer && !BK.newCust) return sheetErr("Pick a customer, or add a new one.");
    if (start == null) return sheetErr("Pick a time, or turn on “Any time”.");
    var body = { pkg: BK.pkg, size: BK.size, adds: BK.adds, day: document.getElementById("bkDay").value, start: start, anyTime: any, price: document.getElementById("bkOver").value,
      notes: document.getElementById("bkNotes").value, ownerNotes: document.getElementById("bkOwn").value, notify: document.getElementById("bkNotify").checked,
      pay: (sheetRoot.querySelector("#bkPay [aria-pressed=true]") || {}).dataset ? sheetRoot.querySelector("#bkPay [aria-pressed=true]").dataset.v : "later" };
    if (BK.pkg === "custom") { body.customName = document.getElementById("bkCname").value; body.durationMin = +document.getElementById("bkDur").value; }
    var vsel = document.getElementById("bkVeh").value;
    if (vsel === "new") body.newVehicle = readVeh(document.getElementById("bkNewVeh")); else if (vsel) body.vehicleId = vsel;
    var done = busy(sb, "Booking…");
    var ready = Promise.resolve(BK.customer && BK.customer.id);
    if (BK.newCust) { var nc = document.getElementById("bkNC"), g = function (n) { return nc.querySelector('[name="' + n + '"]').value; };
      ready = post("/customers", { name: g("name"), phone: g("phone"), email: g("email"), address: g("address"), town: g("town") }).then(function (r) { CUSTS = null; BK.customer = { id: r.id, name: g("name"), initials: "" }; BK.newCust = false; return r.id; }); }
    ready.then(function (cid) { body.customerId = cid; return post("/jobs", body); }).then(function (r) {
      closeSheet(true); buzz(); toast("Booked " + r.id); go("#job/" + r.id);
    }).catch(function (e) { done(); sheetErr(e.message); });
  }

  function openMove() {
    var j = JOB, len = Math.round((j.end_utc - j.start_utc) / 60000);
    BK = { move: true, start: null, day: j.day };
    openSheet("Reschedule", '<form id="mvf" class="fg"><p class="sub" style="margin:-6px 0 0">Now: ' + esc(whenUtc(j.start_utc)) + " · " + hrs(len) + '</p><label class="f">New date<input type="date" id="mvDay" value="' + esc(j.day) + '"></label>' +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Open times<div id="mvTimes" class="pills"></div><label class="chk" style="font-size:14px;color:var(--fg)"><input type="checkbox" id="mvAny"> Any time (ignore my calendar)</label><input type="time" id="mvAt" step="900" hidden value="' + hhmm(new Date(j.start_utc).getHours() * 60) + '"></div>' +
      (j.email ? '<label class="chk"><input type="checkbox" id="mvNotify" checked> Email ' + esc(j.name.split(" ")[0]) + " the new time</label>" : '<p class="note">No email on file: text them the new time.</p>') +
      '<p class="err" data-err hidden></p><button class="btn lg w" type="submit">Move it</button></form>', { guard: false });
    moveTimes();
  }
  function moveTimes() {
    var j = JOB, len = Math.round((j.end_utc - j.start_utc) / 60000), day = document.getElementById("mvDay").value, el = document.getElementById("mvTimes");
    el.innerHTML = '<span class="dim small">Checking…</span>';
    post("/jobs/preview", { pkg: j.custom ? "custom" : j.pkg, size: j.size, adds: j.kind === "member" ? [] : j.adds, durationMin: len, day: day, exceptId: j.id }).then(function (p) {
      var d = p.day; BK.start = null;
      if (!d || !d.times.length) { el.innerHTML = '<span class="dim small">No open time that day. Use “Any time” to move it anyway.</span>'; return; }
      el.innerHTML = d.times.map(function (m) { return '<button type="button" data-v="' + m + '" aria-pressed="false">' + tmin(m) + "</button>"; }).join("");
    }).catch(function (e) { el.textContent = e.message; });
  }
  function submitMove(form) {
    var any = document.getElementById("mvAny").checked, start = any ? fromHHMM(document.getElementById("mvAt").value) : BK.start, day = document.getElementById("mvDay").value;
    if (start == null) return sheetErr("Pick a time.");
    var sb = form.querySelector('[type="submit"]'), done = busy(sb, "Moving…"), n = document.getElementById("mvNotify");
    post("/jobs/" + JOB.id + "/move", { day: day, start: start, anyTime: any, notify: n ? n.checked : false }).then(function (r) { closeSheet(true); buzz(); toast("Moved to " + r.when); renderJob(JOB.id); })
      .catch(function (e) { done(); sheetErr(e.message); });
  }
  function openCancel() {
    var j = JOB, member = j.kind === "member", hoursLeft = (j.start_utc - Date.now()) / 3600e3;
    var opts = [["customer", "The customer asked to cancel", member ? (hoursLeft >= 48 ? "They get a 50% credit for the visit (48+ hours' notice)." : "Under 48 hours' notice: no credit.") : "No charge. They get a cancellation email."],
      ["us", "Weather or our side", member ? "They get a full credit for the visit." : "No charge. They're asked to pick a new time."],
      ["noshow", "No-show / couldn't do it", "No email. Counts on their record (your terms let you ask for a card on file next time)."]];
    openSheet("Cancel this job", '<form id="cxf" class="fg">' + opts.map(function (o, i) { return '<label class="card chk" style="align-items:flex-start;cursor:pointer"><input type="radio" name="why" value="' + o[0] + '"' + (i === 0 ? " checked" : "") + '><span><b>' + o[1] + '</b><span class="dim small" style="display:block">' + o[2] + "</span></span></label>"; }).join("") +
      (j.startsMembership ? '<p class="note warnc">This job starts their Apex Membership (' + esc(j.startsMembership.label) + "). Cancelling it cancels the membership too, with no charge.</p>" : "") +
      (j.email ? '<label class="chk"><input type="checkbox" id="cxNotify" checked> Email the customer</label>' : "") +
      '<p class="err" data-err hidden></p><button class="btn d lg w" type="submit">Cancel job</button></form>', { guard: false, close: "Keep it" });
  }
  function submitCancel(form) {
    var why = (form.querySelector("[name=why]:checked") || {}).value, n = document.getElementById("cxNotify");
    var sb = form.querySelector('[type="submit"]'), done = busy(sb, "Cancelling…");
    post("/jobs/" + JOB.id + "/cancel", { reason: why, notify: n ? n.checked : false }).then(function (r) { closeSheet(true); toast("Cancelled" + (r.credit ? ", " + money(r.credit) + " credit added" : "")); renderJob(JOB.id); })
      .catch(function (e) { done(); sheetErr(e.message); });
  }
  function openEditJob() {
    var j = JOB, member = j.kind === "member", pkg = j.custom ? "custom" : j.pkg, len = Math.round((j.end_utc - j.start_utc) / 60000);
    BK = { pkg: pkg, size: j.size, adds: (j.adds || []).slice(), edit: true };
    var vehOpts = "";
    var h = '<form id="ejf" class="fg" autocomplete="off">';
    if (!member) h += '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Package<div class="pills" id="bkPkg">' + ["exterior", "interior", "full", "custom"].map(function (k) { return '<button type="button" data-v="' + k + '" aria-pressed="' + (k === pkg) + '">' + PKG[k] + "</button>"; }).join("") + "</div></div>" +
      '<div id="bkCustom" class="fg2"' + (pkg === "custom" ? "" : " hidden") + '><label class="f">Package name<input type="text" id="bkCname" maxlength="40" value="' + esc(j.customName || "") + '"></label><label class="f">Length<select id="bkDur">' + [30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, len].filter(function (m, i, a) { return a.indexOf(m) === i; }).sort(function (a, b) { return a - b; }).map(function (m) { return '<option value="' + m + '"' + (m === len ? " selected" : "") + ">" + hrs(m) + "</option>"; }).join("") + "</select></label></div>" +
      '<div class="f" style="display:grid;gap:6px;font-size:13.5px;color:var(--muted)">Size<div class="pills" id="bkSize">' + SIZES.map(function (s, i) { return '<button type="button" data-v="' + i + '" aria-pressed="' + (i === j.size) + '">' + s + "</button>"; }).join("") + "</div></div>" +
      '<div id="bkAdds" class="fg" style="gap:8px"></div>' +
      '<label class="f">Price before tax<input type="number" id="ejPrice" inputmode="decimal" min="0" max="5000" value="' + esc(j.quote == null ? "" : j.quote) + '"><span class="dim small">Changing the package recalculates it unless you type a price.</span></label>';
    h += '<label class="f">Vehicle<select id="ejVeh"><option value="">Loading…</option></select></label>' +
      '<div class="fg2"><label class="f">Address<input type="text" id="ejAddr" maxlength="160" value="' + esc(j.address || "") + '"></label><label class="f">Town<input type="text" id="ejTown" maxlength="60" value="' + esc(j.town || "") + '"></label></div>' +
      '<div class="fg2"><label class="f">Water spigot<select id="ejWater"><option value="">—</option><option value="yes"' + (j.water === "yes" ? " selected" : "") + '>Yes</option><option value="no"' + (j.water === "no" ? " selected" : "") + '>No</option></select></label><label class="f">Outlet<select id="ejPower"><option value="">—</option><option value="yes"' + (j.power === "yes" ? " selected" : "") + '>Yes</option><option value="no"' + (j.power === "no" ? " selected" : "") + ">No</option></select></label></div>" +
      '<label class="f">Job notes<textarea id="ejNotes" maxlength="1500">' + esc(j.notes || "") + "</textarea></label>" +
      '<p class="err" data-err hidden></p><button class="btn lg w" type="submit">Save</button></form>';
    openSheet("Edit job", h);
    if (!member) drawAdds();
    if (j.customer) api("/customers/" + j.customer.id).then(function (d) {
      var sel = document.getElementById("ejVeh"); if (!sel) return;
      sel.innerHTML = '<option value="">' + esc(j.car || "No vehicle") + (j.vehicle ? "" : " (as booked)") + "</option>" + d.vehicles.map(function (v) { return '<option value="' + esc(v.id) + '"' + (j.vehicle && j.vehicle.id === v.id ? " selected" : "") + ">" + esc(v.name + (v.color ? " · " + v.color : "")) + "</option>"; }).join("");
    });
  }
  function submitEditJob(form) {
    var j = JOB, body = { address: document.getElementById("ejAddr").value, town: document.getElementById("ejTown").value, water: document.getElementById("ejWater").value, power: document.getElementById("ejPower").value, notes: document.getElementById("ejNotes").value };
    var vs = document.getElementById("ejVeh").value; if (vs || j.vehicle) body.vehicleId = vs;
    if (j.kind !== "member") {
      var pkgChanged = BK.pkg !== (j.custom ? "custom" : j.pkg) || BK.size !== j.size || BK.adds.join() !== (j.adds || []).join();
      if (pkgChanged) { body.pkg = BK.pkg; body.size = BK.size; body.adds = BK.adds; }
      if (BK.pkg === "custom") { body.pkg = "custom"; body.customName = document.getElementById("bkCname").value; body.durationMin = +document.getElementById("bkDur").value; }
      var pr = document.getElementById("ejPrice").value; if (pr !== "" && +pr !== j.quote) body.price = pr; else if (!pkgChanged && BK.pkg !== "custom") delete body.price;
    }
    var sb = form.querySelector('[type="submit"]'), done = busy(sb, "Saving…");
    post("/jobs/" + j.id + "/edit", body).then(function () { closeSheet(true); toast("Saved"); renderJob(j.id); }).catch(function (e) { done(); sheetErr(e.message); });
  }

  // ---------- People ----------
  RENDER.people = function () {
    loading();
    var path = S.people === "members" ? "/members" : "/customers" + (S.archived ? "?archived=1" : "");
    api(path).then(function (d) { PCACHE[S.people] = d; if (S.people === "customers" && !S.archived) CUSTS = d.customers; drawPeople(); }).catch(fail);
  };
  function drawPeople() {
    var d = PCACHE[S.people], q = S.q.toLowerCase().trim(), qd = tel(q);
    var h = '<div class="row" style="align-items:flex-start"><div><h1>People</h1><p class="sub">' + (S.people === "members" ? "Everyone on Apex Membership." : S.archived ? "Archived customers (records kept)." : "Everyone who has booked, signed in, or you added.") + "</p></div>" +
      (S.people === "customers" && !S.archived ? '<button class="btn sm" data-newcust>+ Add</button>' : "") + "</div>";
    h += '<div class="seg">' + [["customers", "Customers"], ["members", "Apex Members"]].map(function (s) { return '<button data-people="' + s[0] + '" aria-pressed="' + (s[0] === S.people) + '">' + s[1] + "</button>"; }).join("") + "</div>";
    h += '<input type="search" id="pq" placeholder="Search name, phone, email, car or plate" value="' + esc(S.q) + '" style="margin-bottom:12px" aria-label="Search people">';
    var list = S.people === "members" ? d.members : d.customers;
    list = list.filter(function (x) { if (!q) return true; var hay = [x.name, x.email, x.phone, x.town, x.vehicle, x.car, x.label].concat(x.plates || []).join(" ").toLowerCase(); return hay.indexOf(q) > -1 || (qd.length >= 3 && tel(x.phone).indexOf(qd) > -1); });
    if (S.people === "members") {
      h += list.length ? '<div class="list">' + list.map(function (m) {
        return '<div class="card tap" data-href="#member/' + esc(m.id) + '" role="link" tabindex="0"><div class="row"><div><div style="font-weight:650">' + esc(m.name) + '</div><div class="small">' + esc(m.label) + " · " + money(m.monthly) + "/mo + tax</div>" +
          '<div class="muted small">' + (m.nextBill && m.status !== "cancelled" ? "Next charge " + esc(dlabel(m.nextBill)) + " · " : "") + m.paymentsMade + " paid" + (m.credit ? " · " + money(m.credit) + " credit" : "") + (m.owed ? " · owes " + money(m.owed) : "") + (m.endsOn ? " · ends " + esc(dlabel(m.endsOn)) : "") + "</div></div>" + stBadge(m.status) + "</div></div>";
      }).join("") + "</div>" : '<div class="card empty">No members' + (q ? " match" : " yet") + ".</div>";
    } else {
      h += list.length ? '<div class="list">' + list.map(function (c) {
        var line2 = [c.vehicle ? c.vehicle + (c.vehicles > 1 ? " +" + (c.vehicles - 1) : "") : "", c.town].filter(Boolean).join(" · ");
        var line3 = [c.details + " detail" + (c.details === 1 ? "" : "s") + (c.visits ? " + " + c.visits + " visit" + (c.visits === 1 ? "" : "s") : ""), c.lastDay ? "last " + dlabel(c.lastDay) : "", c.paid ? money(c.paid) + " paid" : ""].filter(Boolean).join(" · ");
        return '<div class="card tap" data-href="#customer/' + esc(c.id) + '" role="link" tabindex="0"><div class="jrow"><span class="avatar">' + esc(c.initials) + '</span><div class="jm"><div style="font-weight:650">' + esc(c.name || c.email || "Customer") + "</div>" +
          (line2 ? '<div class="muted small">' + esc(line2) + "</div>" : "") + '<div class="dim small">' + esc(line3) + '</div></div><div class="jb">' +
          (c.member && c.member !== "cancelled" ? '<span class="badge block">Member</span>' : "") + (c.noshows ? '<span class="badge bad">' + c.noshows + " no-show" + (c.noshows > 1 ? "s" : "") + "</span>" : "") + "</div></div></div>";
      }).join("") + "</div>" : '<div class="card empty">No customers' + (q ? " match" : " yet") + ".</div>";
      if (!S.archived && d.archivedCount) h += '<p class="note" style="text-align:center;margin-top:14px"><button class="lnk" data-archived="1">Archived (' + d.archivedCount + ")</button></p>";
      if (S.archived) h += '<p class="note" style="text-align:center;margin-top:14px"><button class="lnk" data-archived="0">Back to customers</button></p>';
    }
    main.innerHTML = h;
    var inp = document.getElementById("pq"); if (S.q) { inp.focus(); inp.setSelectionRange(S.q.length, S.q.length); }
  }

  // ---------- Customer screen ----------
  var CUST = null;
  function renderCustomer(id) {
    if (!CUST || CUST.customer.id !== id) loading();
    api("/customers/" + id).then(function (d) { CUST = d; drawCustomer(); }).catch(fail);
  }
  function drawCustomer() {
    var d = CUST, c = d.customer, ph = tel(c.phone), where = [c.address, c.town].filter(Boolean).join(", ");
    var h = backBtn() + '<div class="phead"><span class="avatar lg">' + esc(c.initials) + '</span><div style="min-width:0"><h1 style="margin:0">' + esc(c.name || c.email || "Customer") + '</h1><div class="muted small">Customer since ' + esc(dateUtc(c.since, true)) + "</div>" +
      '<div class="acts" style="margin-top:6px">' + (d.membership && !d.membership.cancelled ? '<a class="badge block" href="#member/' + esc(d.membership.id) + '" data-href="#member/' + esc(d.membership.id) + '">Apex Member</a>' : "") + (d.noshows ? '<span class="badge bad">' + d.noshows + " no-show" + (d.noshows > 1 ? "s" : "") + "</span>" : "") + (c.archived ? '<span class="badge">Archived</span>' : "") + "</div></div></div>";
    h += '<div class="contact"><a href="tel:' + esc(ph) + '"' + (ph ? "" : ' aria-disabled="true"') + ">" + IC.phone + "Call</a>" +
      '<a href="sms:' + esc(ph) + '"' + (ph ? "" : ' aria-disabled="true"') + ">" + IC.msg + "Text</a>" +
      '<a href="mailto:' + esc(c.email || "") + '"' + (c.email ? "" : ' aria-disabled="true"') + ">" + IC.mail + "Email</a>" +
      '<a href="https://maps.apple.com/?q=' + encodeURIComponent(where) + '" target="_blank" rel="noopener"' + (where ? "" : ' aria-disabled="true"') + ">" + IC.map + "Maps</a></div>";
    h += '<div class="acts" style="margin-top:14px">' + (c.archived ? '<button class="btn" data-restore="' + esc(c.id) + '">Restore</button>' : '<button class="btn" data-newjob data-cust="' + esc(c.id) + '">+ Book a job</button>') + '<button class="btn g" data-editcust>Edit</button></div>';
    h += '<div class="card" style="margin-top:14px">' + kv("Phone", c.phone || "—") + kv("Email", c.email || "No email") + kv("Address", where || "—") + kv("Card on file", c.card || "None") + kv("Texts", c.sms_ok ? "OK to text" : "Not opted in") +
      (c.their_notes ? kv("Their notes", c.their_notes) : "") + "</div>";
    h += '<label class="f" style="margin-top:14px">Your notes (gate codes, pets, preferences)<textarea id="cNotes">' + esc(c.owner_notes) + '</textarea></label><div class="pills" style="margin-top:8px">' + QUICK_NOTES.map(function (n) { return '<button type="button" data-qnote="' + esc(n) + '">+ ' + esc(n) + "</button>"; }).join("") + '</div><div class="acts" style="margin-top:8px"><button class="btn g sm" data-savecnotes>Save notes</button></div>';
    h += '<h2>Vehicles <button class="btn g sm r" data-addveh>+ Add</button></h2><div class="card">' + (d.vehicles.length ? d.vehicles.map(function (v) {
      return '<div class="vehicle"><div><b>' + esc(v.name) + "</b>" + (v.color ? ' <span class="muted">· ' + esc(v.color) + "</span>" : "") + (v.plate ? ' <span class="plate">' + esc(v.plate) + "</span>" : "") +
        '<div class="dim small">' + esc([v.size != null ? SIZES[v.size] : "", v.notes].filter(Boolean).join(" · ")) + '</div></div><button class="btn g sm" data-editveh="' + esc(v.id) + '">Edit</button></div>';
    }).join("") : '<p class="empty" style="padding:6px">No vehicles yet.</p>') + "</div>";
    if (d.membership) { var m = d.membership; h += '<h2>Apex Membership</h2><div class="card tap" data-href="#member/' + esc(m.id) + '"><div class="row"><div><b>' + esc(m.label) + '</b><div class="muted small">' + money(m.monthly) + "/mo + tax" + (m.nextBill ? " · next charge " + esc(dlabel(m.nextBill)) : "") + "</div></div>" + stBadge(m.status) + "</div></div>"; }
    h += "<h2>Jobs</h2>" + (d.jobs.length ? '<div class="list">' + d.jobs.map(function (j) { return jobCard(j); }).join("") + "</div>" : '<div class="card empty">No jobs yet.</div>');
    if (d.log && d.log.length) h += '<h2>History</h2><div class="card">' + d.log.map(function (l) { return '<div class="logl"><b>' + esc(dateUtc(l.at)) + "</b>" + esc(l.what) + "</div>"; }).join("") + "</div>";
    h += '<div class="acts" style="margin-top:22px">' + (c.archived ? "" : '<button class="btn d sm" data-delcust>Delete customer</button>') + "</div>";
    main.innerHTML = h;
  }
  function openCustomer(c) {
    c = c || {};
    openSheet(c.id ? "Edit customer" : "New customer", '<form id="cf" class="fg" autocomplete="off">' +
      '<label class="f">Name<input type="text" name="name" maxlength="80" value="' + esc(c.name || "") + '" required></label>' +
      '<div class="fg2"><label class="f">Phone<input type="tel" name="phone" maxlength="30" value="' + esc(c.phone || "") + '"></label><label class="f">Email<input type="email" name="email" maxlength="120" value="' + esc(c.email || "") + '"></label></div>' +
      '<label class="f">Street address<input type="text" name="address" maxlength="160" value="' + esc(c.address || "") + '"></label><label class="f">Town<input type="text" name="town" maxlength="60" value="' + esc(c.town || "") + '"></label>' +
      (c.id ? "" : '<label class="f">Your notes<textarea name="owner_notes" maxlength="2000" placeholder="Gate code, pets…"></textarea></label>') +
      (c.id && c.email && c.account ? '<p class="note">Changing the email also changes the email they sign in with.</p>' : "") +
      '<p class="err" data-err hidden></p><button class="btn lg w" type="submit"' + (c.name ? "" : " disabled") + ">Save</button></form>");
  }
  function submitCustomer(form) {
    var fd = new FormData(form), body = {}; ["name", "phone", "email", "address", "town", "owner_notes"].forEach(function (k) { if (fd.has(k)) body[k] = fd.get(k); });
    var id = CUST && S.detail && S.detail.type === "customer" ? CUST.customer.id : null, sb = form.querySelector('[type="submit"]'), done = busy(sb, "Saving…");
    (id ? post("/customers/" + id, body) : post("/customers", body)).then(function (r) { CUSTS = null; PCACHE = {}; closeSheet(true); toast("Saved"); if (id) renderCustomer(id); else go("#customer/" + r.id); })
      .catch(function (e) { done(); sheetErr(e.message); });
  }
  function openVehicle(v) {
    v = v || {};
    openSheet(v.id ? "Edit vehicle" : "Add vehicle", '<form id="vf" class="fg" autocomplete="off">' + vehFields(v) + '<label class="f">Notes<textarea name="notes" maxlength="500" style="min-height:60px" placeholder="Ceramic coated, scratch on rear bumper…">' + esc(v.notes || "") + "</textarea></label>" +
      '<input type="hidden" name="vid" value="' + esc(v.id || "") + '"><p class="err" data-err hidden></p><button class="btn lg w" type="submit">Save</button>' + (v.id ? '<button type="button" class="btn d w" data-delveh="' + esc(v.id) + '">Delete vehicle</button><p class="note">Deleting keeps their past jobs and photos.</p>' : "") + "</form>");
  }
  function submitVehicle(form) {
    var body = readVeh(form), vid = form.querySelector("[name=vid]").value, sb = form.querySelector('[type="submit"]'), done = busy(sb, "Saving…");
    (vid ? post("/vehicles/" + vid, body) : post("/customers/" + CUST.customer.id + "/vehicles", body)).then(function () { CUSTS = null; closeSheet(true); toast("Saved"); renderCustomer(CUST.customer.id); })
      .catch(function (e) { done(); sheetErr(e.message); });
  }

  // ---------- Member screen ----------
  var MEMB = null;
  function renderMember(id) {
    if (!MEMB || MEMB.member.id !== id) loading();
    api("/members/" + id).then(function (d) { MEMB = d; drawMember(); }).catch(fail);
  }
  function drawMember() {
    var d = MEMB, m = d.member, c = m.customer, live = m.status !== "cancelled";
    var h = backBtn() + '<div class="row" style="align-items:flex-start"><div><h1>' + esc(c.name || "Member") + '</h1><p class="sub" style="margin:0">' + esc(m.label) + " · " + money(m.monthly) + "/mo + tax</p></div>" + stBadge(m.status) + "</div>";
    h += '<div class="acts"><a class="btn g sm" href="#customer/' + esc(c.id) + '" data-href="#customer/' + esc(c.id) + '">Customer profile</a>' + (c.phone ? '<a class="btn g sm" href="sms:' + esc(tel(c.phone)) + '">Text</a>' : "") + "</div>";
    h += '<div class="card" style="margin-top:14px">' + kv("Since", dlabel(m.since)) + (m.nextBill ? kv("Next charge", dlabel(m.nextBill) + " · " + money(m.nextChargeTotal) + " with tax" + (m.nextWinter ? " (winter pricing)" : "")) : "") +
      kv("Payments made", m.paymentsMade + (m.minLeft ? " (" + m.minLeft + " left in the " + m.minPayments + "-month minimum)" : "")) + (m.periodStart ? kv("Paid period", dlabel(m.periodStart) + " – " + dlabel(addD(m.periodEnd, -1))) : "") +
      kv("Visits this period", m.visitsBooked + " of " + m.visitsAllowed + " booked") + kv("Credit", money(m.credit)) + (m.owed ? kv("Owes", money(m.owed)) : "") + (m.endsOn ? kv("Ends", dlabel(m.endsOn)) : "") + (m.pauseUntil ? kv("Paused until", dlabel(m.pauseUntil)) : "") +
      kv("Card", m.card || "None on file") + kv("Car", (m.car || "") + " · " + SIZES[m.size]) + "</div>";
    if (live) {
      h += '<h2>Change it</h2><div class="menu">';
      if (m.status === "past_due") h += '<button class="btn" data-mem="retry">Retry the failed payment now</button>';
      if (m.status === "active") h += '<button class="btn g" data-mem="pause">Pause</button>';
      if (m.status === "paused") h += '<button class="btn g" data-mem="resume">Resume now</button>';
      h += '<button class="btn g" data-mem="plan">Change plan</button><button class="btn g" data-mem="credit">Add a credit</button>';
      if (m.status !== "ending") h += '<button class="btn d" data-mem="cancel">Cancel membership</button>';
      h += "</div>";
    }
    h += "<h2>Visits</h2>" + (d.visits.length ? '<div class="card">' + d.visits.map(function (v) {
      return '<div class="vehicle tap" data-href="#job/' + esc(v.id) + '"><div><b>' + esc(whenUtc(v.start)) + '</b><div class="dim small">' + esc(PKG[v.pkg] || v.pkg) + (v.reason ? " · " + ({ customer: "skipped", us: "we cancelled", noshow: "no-show" }[v.reason] || "") : "") + (v.credit ? " · " + money(v.credit) + " credit" : "") + "</div></div>" + stateBadge(v.status === "cancelled" ? "cancelled" : v.done ? "done" : "scheduled") + "</div>";
    }).join("") + "</div>" : '<div class="card empty">No visits booked yet.</div>');
    h += "<h2>Charges</h2>" + (d.charges.length ? '<div class="card scroll"><table class="tbl"><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Status</th></tr></thead><tbody>' + d.charges.map(function (x) {
      return "<tr><td>" + esc(dateUtc(x.at)) + "</td><td>" + esc({ monthly: "Monthly", cancel_fee: "Cancel fee", winter_skip: "Winter pause" }[x.kind] || x.kind) + "</td><td>" + money(x.amount + x.tax) + (x.credit ? '<div class="dim small">' + money(x.credit) + " credit</div>" : "") + "</td><td>" + esc(x.status) + (x.error ? '<div class="dim small">' + esc(x.error) + "</div>" : "") + "</td></tr>";
    }).join("") + "</tbody></table></div>" : '<div class="card empty">No charges yet.</div>');
    if (d.log && d.log.length) h += '<h2>History</h2><div class="card">' + d.log.map(function (l) { return '<div class="logl"><b>' + esc(dateUtc(l.at)) + "</b>" + esc(l.what) + "</div>"; }).join("") + "</div>";
    main.innerHTML = h;
  }
  function memSheet(act) {
    var m = MEMB.member, h;
    if (act === "pause") h = '<form id="msf" data-act="pause" class="fg"><p class="sub" style="margin-top:-6px">No charges while paused. Visits they already paid for still count.</p><label class="f">For how long?<select name="months">' + [1, 2, 3, 4, 5, 6].map(function (n) { return '<option value="' + n + '">' + n + " month" + (n > 1 ? "s" : "") + "</option>"; }).join("") + "</select></label>" + (m.minLeft ? '<p class="note warnc">They\'re still in the ' + m.minPayments + "-month minimum. Members can't pause themselves until it's done; you can.</p>" : "") + '<p class="err" data-err hidden></p><button class="btn lg w">Pause</button></form>';
    else if (act === "cancel") {
      var fee = m.cancelFee, opts = [];
      if (m.paymentsMade > 0 && m.minLeft > 0) {
        opts.push(["finish", "Finish the minimum", "Their last " + m.minLeft + " payment" + (m.minLeft > 1 ? "s go" : " goes") + " through, then it ends. No fee."]);
        opts.push(["fee", "Cancel now with the fee", "Charges " + money(fee) + " (half the payments left, no sales tax) to " + (m.card || "their card") + "."]);
        opts.push(["waive", "Cancel now, no fee", "Your call (goodwill). Paid visits still count; no more charges."]);
      } else opts.push(["waive", "Cancel", m.paymentsMade === 0 ? "Before the first charge: free, nothing charged." : "Minimum done: no fee. Active through the paid period."]);
      h = '<form id="msf" data-act="cancel" class="fg">' + opts.map(function (o, i) { return '<label class="card chk" style="align-items:flex-start;cursor:pointer"><input type="radio" name="mode" value="' + o[0] + '"' + (i === 0 ? " checked" : "") + "><span><b>" + o[1] + '</b><span class="dim small" style="display:block">' + o[2] + "</span></span></label>"; }).join("") + '<p class="note">They get an email either way.</p><p class="err" data-err hidden></p><button class="btn d lg w">Cancel membership</button></form>';
    }
    else if (act === "plan") {
      h = '<form id="msf" data-act="plan" class="fg"><label class="f">Plan<select name="type">' + Object.keys(PLANN).map(function (k) { return '<option value="' + k + '"' + (k === m.type ? " selected" : "") + ">" + PLANN[k] + "</option>"; }).join("") + '</select></label><label class="f">How often<select name="freq">' + [1, 2, 4].map(function (f) { return '<option value="' + f + '"' + (f === m.freq ? " selected" : "") + ">" + FREQN[f] + "</option>"; }).join("") + '</select></label><label class="f">Car size<select name="size">' + SIZES.map(function (s, i) { return '<option value="' + i + '"' + (i === m.size ? " selected" : "") + ">" + s + "</option>"; }).join("") + '</select></label><div class="card" id="planPrev"></div><p class="note">The new price starts with their next charge. They get an email.</p><p class="err" data-err hidden></p><button class="btn lg w">Change plan</button></form>';
    }
    else if (act === "credit") h = '<form id="msf" data-act="credit" class="fg"><label class="f">Credit amount<div class="money-in" style="margin:0"><span>$</span><input name="amount" inputmode="decimal" placeholder="25"></div></label><label class="f">Why (only you see this)<input type="text" name="note" maxlength="120" placeholder="e.g. Missed spot, rain delay"></label><p class="note">Comes off their next monthly charge, before tax.</p><p class="err" data-err hidden></p><button class="btn lg w">Add credit</button></form>';
    openSheet({ pause: "Pause membership", cancel: "Cancel membership", plan: "Change plan", credit: "Add a credit" }[act], h, { guard: act === "credit" });
    if (act === "plan") planPrev();
  }
  function planPrev() { var f = document.getElementById("msf"); if (!f || f.dataset.act !== "plan") return; var t = f.type.value, fq = f.freq.value, sz = +f.size.value, p = MEMB.member.prices[t][fq][sz]; document.getElementById("planPrev").innerHTML = kv("New price", money(p) + "/mo + " + money(taxOf(p)) + " tax") + kv("Now", money(MEMB.member.monthly) + "/mo"); }
  function submitMem(form) {
    var act = form.dataset.act, fd = new FormData(form), body = {}; fd.forEach(function (v, k) { body[k] = v; });
    if (act === "cancel" && !confirm(body.mode === "fee" ? "Charge the fee and cancel?" : "Cancel this membership?")) return;
    var sb = form.querySelector("button:not([type=button])"), done = busy(sb, "Working…");
    post("/members/" + MEMB.member.id + "/" + act, body).then(function (r) { closeSheet(true); toast(r.message || "Done", true); renderMember(MEMB.member.id); }).catch(function (e) { done(); sheetErr(e.message); });
  }

  // ---------- Money ----------
  RENDER.money = function () {
    loading();
    api("/money").then(function (d) {
      var X = d.extra || {}, h = '<h1>Money</h1><p class="sub">What came in through the site and Square.' + (d.squareSandbox ? ' <span class="badge warn">Square test mode</span>' : "") + "</p>";
      var T = d.tax, Q = T.quarters, cur = Q.filter(function (q) { return q.current; })[0];
      h += "<h2>" + esc(T.name) + "</h2>" + (cur ? taxCard(cur) : "");
      h += '<div class="card" style="margin-top:10px">' + Q.map(function (q) { return '<div class="qrow"><div><div style="font-weight:650">' + esc(q.label) + (q.current ? ' <span class="dim small">so far</span>' : "") + "</div>" +
          '<div class="dim small">Taxed sales ' + money(q.taxedSales) + (q.sales !== q.taxedSales ? " (all sales " + money(q.sales) + ")" : "") + " · due " + esc(dlabel(q.due)) + "</div></div>" +
          '<div class="qr"><b>' + money(q.tax) + "</b>" + (q.filed ? '<button class="btn g sm" data-taxfiled="' + esc(q.key) + '" data-on="0" title="Undo">Filed ✓</button>' : '<button class="btn ' + (q.current ? "g " : "") + 'sm" data-taxfiled="' + esc(q.key) + '" data-on="1">Mark filed</button>') + "</div></div>"; }).join("") +
        '<p class="dim small" style="margin-top:10px">' + esc(T.pct) + " of every bill: details, add-ons, travel and membership charges. Tips and cancellation fees aren't taxed. Counted when the money comes in, including cash and card payments you mark paid in person. File Form ST-50 with the NJ Division of Taxation and pay this amount by the due date.</p></div>";
      // yearly totals for income taxes
      if (X.years && X.years.length) {
        h += "<h2>Income by year <span class=\"dim small\" style=\"font-weight:500\">for your taxes</span></h2>";
        h += X.years.map(function (y) {
          return '<div class="card" style="margin-bottom:10px"><div class="row"><b style="font-size:18px">' + esc(y.year) + '</b><span class="dim small">' + (y.year === todayNY().slice(0, 4) ? "so far" : "") + "</span></div>" +
            '<div class="grid2" style="margin:10px 0"><div class="stat"><div class="k">Gross income</div><div class="v">' + money(y.gross) + '</div><div class="s">before sales tax</div></div><div class="stat"><div class="k">Square fees</div><div class="v">' + money(y.squareFees) + '</div><div class="s">' + y.squarePayments + " payments</div></div>" +
            '<div class="stat"><div class="k">After fees</div><div class="v">' + money(y.net) + "</div></div></div>" +
            kv("Details", money(y.details)) + kv("Memberships", money(y.members)) + kv("Cancellation fees", money(y.fees)) + kv("Tips", money(y.tips)) + kv("Sales tax collected (not income)", money(y.salesTax)) + "</div>";
        }).join("") + '<p class="note">Gross income leaves out sales tax (that\'s the state\'s money). Square fees are a business expense. Supplies, gas or mileage and insurance aren\'t tracked here: keep those receipts for your accountant.</p>';
      }
      h += "<h2>By month</h2>";
      if (d.months.length) {
        var fm = X.feeMonths || {};
        h += '<div class="card scroll"><table class="tbl"><thead><tr><th>Month</th><th>Details</th><th>Members</th><th>Fees</th><th>Tax</th><th>Tips</th><th>Total in</th><th>Square fees</th></tr></thead><tbody>' +
          d.months.map(function (m) { var p = m.month.split("-"), lbl = new Date(Date.UTC(+p[0], +p[1] - 1, 15)).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", year: "numeric" });
            return "<tr><td>" + lbl + "</td><td>" + money(m.details) + "</td><td>" + money(m.members) + "</td><td>" + money(m.fees) + "</td><td>" + money(m.tax) + "</td><td>" + money(m.tips) + "</td><td><b>" + money(m.details + m.members + m.fees + m.tax + m.tips) + "</b></td><td>" + (fm[m.month] != null ? "−" + money(fm[m.month]) : "—") + "</td></tr>"; }).join("") +
          '</tbody></table><p class="dim small" style="margin-top:8px">Details, members and fees are before tax.</p></div>';
      } else h += '<div class="card empty">Nothing paid yet.</div>';
      // Square
      h += "<h2>Square</h2><div class=\"card\">";
      if (!X.squareOn) h += '<p class="dim small" style="margin:0">Square isn\'t connected.</p>';
      else {
        h += kv("Fees + payments synced", X.squareSync ? ago(X.squareSync.at) : "Not yet") + '<p class="dim small">Every Square payment, including ones you take in the Square app or with Tap to Pay, with its processing fee. Syncs every hour.</p>';
        var P = X.payouts;
        h += '<div style="margin-top:10px"><b>Deposits to your bank</b></div>' + (P && P.list && P.list.length ? P.list.map(function (p) { return kv((p.arrival ? dlabel(p.arrival) : "Pending") + (p.to ? " · " + p.to : ""), money(p.amount) + " · " + String(p.status || "").toLowerCase()); }).join("") : '<p class="dim small">' + (P && P.error ? "Couldn't load deposits: " + esc(P.error) : "No deposits yet" + (d.squareSandbox ? " (test mode doesn't make real deposits)." : ".")) + "</p>");
        h += '<div class="acts"><button class="btn g sm" data-sqsync>Sync Square now</button></div>';
      }
      h += "</div>";
      if (d.methods.length) h += '<h2>How people paid</h2><div class="card">' + d.methods.map(function (m) { return kv(String(m.method || "other").replace(/_/g, " ").replace(":", " · ") + " (" + m.count + ")", money(m.total)); }).join("") + "</div>";
      h += "<h2>Finished, not marked paid</h2>" + (d.unpaid.length ? '<div class="list">' + d.unpaid.map(jobCard).join("") + "</div>" : '<div class="card empty">All caught up.</div>');
      main.innerHTML = h;
    }).catch(fail);
  };

  // ---------- Settings ----------
  var SET = null;
  RENDER.settings = function () {
    loading();
    api("/settings").then(function (d) { SET = d; drawSettings(); }).catch(fail);
  };
  function num(name, val, attrs) { return '<input type="number" inputmode="numeric" name="' + name + '" value="' + esc(val) + '" ' + (attrs || "") + ">"; }
  function drawSettings() {
    var d = SET, E = d.edit, R = E.rules, P = E.pricing, M = E.mem, L = E.locked;
    var h = '<h1>Settings</h1><p class="sub">Change how the site books and prices. Saving updates the website within about 20 seconds. Bookings already made keep their price.</p>';
    h += '<h2>Connections</h2><div class="card">' +
      kv("Apple Calendar", d.calendar ? (d.sync ? "Synced " + ago(d.sync.at) + " · " + d.sync.n + " events" : "Connected") : "Not connected") +
      (d.sync && d.sync.calendars ? kv("Calendars read", d.sync.calendars.join(", ")) : "") +
      kv("Email", d.email ? "On (bookings@apexdetailingoc.com)" : "Off") + kv("Square", d.square === "production" ? "Live" : "Test mode (sandbox)") +
      kv("Photo storage", d.photos ? "On (Cloudflare R2)" : "Off: turn on R2 in Cloudflare") + kv("Texts", "Not set up yet") +
      '<div class="acts"><button class="btn g sm" data-sync>Sync calendar now</button></div></div>';
    h += '<form id="setf" autocomplete="off">';
    h += '<h2>Booking hours</h2><div class="card fg">' +
      '<div class="fg2"><label class="f">Earliest start<input type="time" name="r.startMin" step="900" value="' + hhmm(R.startMin) + '"></label><label class="f">Done by<input type="time" name="r.latestEnd" step="900" value="' + hhmm(R.latestEnd) + '"></label></div>' +
      '<label class="chk"><input type="checkbox" name="r.bySunset"' + (R.bySunset ? " checked" : "") + "> Or by sunset, whichever is first</label>" +
      '<div class="fg2"><label class="f">Buffer around events and jobs<select name="r.gapMin">' + [0, 15, 30, 45, 60, 75, 90, 120].map(function (m) { return '<option value="' + m + '"' + (m === R.gapMin ? " selected" : "") + ">" + (m ? hrs(m) : "None") + "</option>"; }).join("") + "</select></label>" +
      '<label class="f">Start times every<select name="r.stepMin">' + [15, 30, 60].map(function (m) { return '<option value="' + m + '"' + (m === R.stepMin ? " selected" : "") + ">" + m + " min</option>"; }).join("") + "</select></label></div>" +
      '<div class="fg2"><label class="f">Jobs per day<select name="r.maxJobs">' + [1, 2, 3, 4].map(function (n) { return '<option' + (n === R.maxJobs ? " selected" : "") + ">" + n + "</option>"; }).join("") + '</select></label><label class="f">On a full day off<select name="r.maxJobsDayOff">' + [1, 2, 3, 4].map(function (n) { return '<option' + (n === R.maxJobsDayOff ? " selected" : "") + ">" + n + "</option>"; }).join("") + "</select></label></div>" +
      '<label class="f">Booking window (days ahead)' + num("r.horizonDays", R.horizonDays, 'min="7" max="180"') + "</label>" +
      '<label class="chk"><input type="checkbox" name="r.winterOn"' + (R.winterOn ? " checked" : "") + "> Winter mode: Interior only</label>" +
      '<div class="fg2"><label class="f">Winter starts' + mdSel("r.ws", R.winter.start) + '</label><label class="f">Winter ends' + mdSel("r.we", R.winter.end) + "</label></div>" +
      '<p class="note" style="margin:0">This only changes what customers can book. Membership winter (Wash paused, Wash + interior billed at the Interior price, Dec 15 – Mar 1) is fixed by your Membership Terms.</p>' +
      '<div class="locked"><span><span class="lock-ic">LOCKED</span> Customers must book ' + L.noticeHours + ' hours ahead, and change for free until then</span><b>In your Terms</b></div></div>';
    h += '<h2>Job lengths <span class="dim small" style="font-weight:500">minutes</span></h2><div class="card scroll"><table class="tbl"><thead><tr><th></th><th>Sedan</th><th>SUV</th><th>Truck</th></tr></thead><tbody>' +
      ["exterior", "interior", "full"].map(function (k) { return "<tr><td>" + PKG[k] + "</td>" + [0, 1, 2].map(function (i) { return "<td>" + num("r.base." + k + "." + i, R.baseMin[k][i], 'step="15" min="30" max="720"') + "</td>"; }).join("") + "</tr>"; }).join("") +
      '</tbody></table><div class="fg2" style="margin-top:12px">' + Object.keys(ADDN).map(function (a) { return '<label class="f">' + ADDN[a] + " (extra min)" + num("r.add." + a, R.addonMin[a], 'step="5" min="0" max="240"') + "</label>"; }).join("") + "</div>" +
      '<div class="fg2" style="margin-top:12px"><label class="f">Member Interior visits are shorter by' + num("r.mem.interior", R.memberLessMin.interior, 'step="15" min="0"') + '</label><label class="f">Member Wash + interior shorter by' + num("r.mem.full", R.memberLessMin.full, 'step="15" min="0"') + "</label></div></div>";
    h += '<h2>Prices <span class="dim small" style="font-weight:500">before tax</span></h2><div class="card">' +
      '<label class="chk"><input type="checkbox" name="p.launchSale"' + (P.launchSale ? " checked" : "") + "> Launch sale on (first detail only)</label>" +
      '<div class="scroll" style="margin-top:10px"><table class="tbl"><thead><tr><th></th><th>Sedan</th><th>SUV</th><th>Truck</th></tr></thead><tbody>' +
      ["exterior", "interior", "full"].map(function (k) { return "<tr><td>" + PKG[k] + "</td>" + [0, 1, 2].map(function (i) { return "<td>" + num("p.reg." + k + "." + i, P.regular[k][i], 'min="0" max="2000"') + "</td>"; }).join("") + "</tr>" +
        '<tr><td class="dim small">Launch</td>' + [0, 1, 2].map(function (i) { return "<td>" + num("p.launch." + k + "." + i, P.launch[k][i], 'min="0" max="2000"') + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>" +
      '<div class="fg2" style="margin-top:12px">' + Object.keys(ADDN).map(function (a) { return '<label class="f">' + ADDN[a] + " ($)" + num("p.add." + a, P.addons[a], 'min="0" max="1000"') + "</label>"; }).join("") + "</div>" +
      '<label class="f" style="margin-top:12px">Member add-on discount (%)' + num("p.memAdd", Math.round(P.memberAddonDiscount * 100), 'min="0" max="50"') + "</label>" +
      '<div class="fg3" style="margin-top:12px">' + P.zones.map(function (z, i) { return '<label class="f">Travel up to ' + z.max + " mi ($)" + num("p.zone." + i, z.fee, 'min="0" max="300"') + "</label>"; }).join("") + "</div>" +
      '<div class="locked"><span><span class="lock-ic">LOCKED</span> Travel zone distances (' + L.zoneMiles.join(" / ") + ' mi)</span><b>Drawn on your map</b></div></div>';
    h += '<h2>Apex Membership prices</h2><div class="card">' +
      '<p class="dim small" style="margin-top:0">Each plan\'s monthly price per visit is a share of the matching package\'s regular price, rounded to $5. Changes apply to new members; current members keep their price.</p>' +
      '<div class="fg3">' + [["wash", "Wash (of Exterior)"], ["int", "Interior (of Interior)"], ["both", "Wash + interior (of Full)"]].map(function (x) { return '<label class="f">' + x[1] + " %" + num("m.pct." + x[0], Math.round(M.pct[x[0]] * 100), 'min="10" max="100"') + "</label>"; }).join("") + "</div>" +
      '<div class="fg2" style="margin-top:12px"><label class="f">Every-2-weeks discount %' + num("m.f2", Math.round(M.freqDiscount[2] * 100), 'min="0" max="50"') + '</label><label class="f">Weekly discount %' + num("m.f4", Math.round(M.freqDiscount[4] * 100), 'min="0" max="50"') + "</label></div>" +
      '<div id="memPrev" class="dim small" style="margin-top:10px"></div>' +
      '<div class="locked"><span><span class="lock-ic">LOCKED</span> ' + L.minPayments + "-month minimum · cancel fee " + Math.round(L.cancelFeeRate * 100) + "% of payments left · skip credit " + Math.round(L.skipCreditRate * 100) + "% with " + L.skipNoticeHours + "h notice · sign up within " + L.signupDays + " days</span><b>In your Membership Terms</b></div></div>";
    h += '<p class="err" id="setErr" hidden style="margin-top:12px"></p><div style="position:sticky;bottom:calc(env(safe-area-inset-bottom) + 10px);margin-top:14px;display:flex;gap:8px"><button class="btn lg" type="submit" style="flex:1">Save changes</button>' + (E.changed ? '<button class="btn g lg" type="button" data-resetset>Reset</button>' : "") + "</div></form>";
    h += '<p class="note">Locked rules are written into your Terms. To change one, ask Claude to update the Terms too, so customers agree to the new version.' + (E.updatedAt ? " Last changed " + esc(ago(E.updatedAt)) + "." : "") + "</p>";
    h += '<h2>Backup</h2><div class="card"><p class="dim small" style="margin-top:0">Your data lives in Cloudflare (and photos in R2), not on this phone, so a lost phone loses nothing. Download a copy anytime.</p><div class="acts"><a class="btn g sm" href="/api/admin/export" download>Download data backup (.json)</a></div></div>';
    h += '<h2>This phone</h2><div class="card">' + kv("Home-screen app", window.matchMedia("(display-mode: standalone)").matches || navigator.standalone ? "Yes" : "Not yet: Safari → Share → Add to Home Screen") +
      kv("Photos waiting to upload", String(window.ApexPhotos ? window.ApexPhotos.pendingCount() : 0)) + '<div class="acts"><button class="btn g sm" data-qretry>Retry uploads now</button></div></div>';
    main.innerHTML = h;
    memPrev();
  }
  function mdSel(name, v) {
    var mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return '<div class="fg2" style="gap:6px"><select name="' + name + 'm">' + mo.map(function (m, i) { return '<option value="' + (i + 1) + '"' + (i + 1 === v[0] ? " selected" : "") + ">" + m + "</option>"; }).join("") + '</select><select name="' + name + 'd">' + Array.from({ length: 31 }, function (_, i) { return '<option' + (i + 1 === v[1] ? " selected" : "") + ">" + (i + 1) + "</option>"; }).join("") + "</select></div>";
  }
  function setVal(f, n) { var el = f.elements[n]; return el ? (el.type === "checkbox" ? el.checked : el.value) : null; }
  function readSettings(f) {
    var g = function (n) { return setVal(f, n); }, n = function (x) { var v = g(x); return v === "" || v == null ? "" : Number(v); }, pc = function (x) { var v = n(x); return v === "" ? "" : v / 100; };
    var base = {}, add = {}, reg = {}, lau = {}, padd = {};
    ["exterior", "interior", "full"].forEach(function (k) { base[k] = [0, 1, 2].map(function (i) { return n("r.base." + k + "." + i); }); reg[k] = [0, 1, 2].map(function (i) { return n("p.reg." + k + "." + i); }); lau[k] = [0, 1, 2].map(function (i) { return n("p.launch." + k + "." + i); }); });
    Object.keys(ADDN).forEach(function (a) { add[a] = n("r.add." + a); padd[a] = n("p.add." + a); });
    return { rules: { startMin: fromHHMM(g("r.startMin")), latestEnd: fromHHMM(g("r.latestEnd")), bySunset: g("r.bySunset"), gapMin: n("r.gapMin"), stepMin: n("r.stepMin"), maxJobs: n("r.maxJobs"), maxJobsDayOff: n("r.maxJobsDayOff"), horizonDays: n("r.horizonDays"),
        winterOn: g("r.winterOn"), winter: { start: [n("r.wsm"), n("r.wsd")], end: [n("r.wem"), n("r.wed")] }, baseMin: base, addonMin: add, memberLessMin: { exterior: 0, interior: n("r.mem.interior"), full: n("r.mem.full") } },
      pricing: { launchSale: g("p.launchSale"), regular: reg, launch: lau, addons: padd, memberAddonDiscount: pc("p.memAdd"), zoneFees: SET.edit.pricing.zones.map(function (_, i) { return n("p.zone." + i); }) },
      mem: { pct: { wash: pc("m.pct.wash"), int: pc("m.pct.int"), both: pc("m.pct.both") }, freqDiscount: { 2: pc("m.f2"), 4: pc("m.f4") } } };
  }
  function memPrev() {
    var f = document.getElementById("setf"), el = document.getElementById("memPrev"); if (!f || !el) return;
    var r5 = function (x) { return Math.round(x / 5) * 5; }, s = readSettings(f), of = { wash: "exterior", int: "interior", both: "full" };
    el.textContent = "Sedan, monthly: " + Object.keys(of).map(function (k) { return PLANN[k] + " $" + r5(s.pricing.regular[of[k]][0] * s.mem.pct[k]); }).join(" · ") + " (+ tax)";
  }
  function saveSettings(f) {
    var b = f.querySelector('[type="submit"]'), done = busy(b, "Saving…"), err = document.getElementById("setErr"); err.hidden = true;
    post("/settings", readSettings(f)).then(function () { done(); SH.dirty = false; toast("Saved. The site updates within 20 seconds."); RENDER.settings(); })
      .catch(function (e) { done(); err.textContent = e.message; err.hidden = false; err.scrollIntoView({ block: "center" }); });
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target, b;
    if ((b = t.closest(".tabs button"))) { S.depth = 0; return (location.hash = "#" + b.dataset.tab); }
    if (t.closest("[data-signin]")) return location.reload();
    if (t.closest("[data-back]")) return goBack();
    if ((b = t.closest("[data-go]"))) { if (b.dataset.people) { S.people = b.dataset.people; S.q = ""; } S.depth = 0; location.hash = "#" + b.dataset.go; if (S.tab === b.dataset.go && !S.detail) RENDER[S.tab](); return; }
    if ((b = t.closest("[data-href]"))) { if (t.closest("a[href^='tel'],a[href^='sms'],a[href^='mailto'],a[target]") ) return; e.preventDefault(); return go(b.dataset.href); }
    if (t.closest("[data-reload]")) return refresh();
    if ((b = t.closest("[data-copy]"))) return copy(b.dataset.copy);
    if ((b = t.closest("[data-taxfiled]"))) { var on = b.dataset.on === "1"; if (on && !confirm("Mark this quarter's sales tax as filed and paid?")) return; b.disabled = true;
      post("/tax/" + b.dataset.taxfiled + "/filed", { filed: on }).then(function () { toast(on ? "Marked filed" : "Unmarked"); RENDER.money(); }).catch(function (e2) { toast(e2.message); b.disabled = false; }); return; }
    if ((b = t.closest("[data-sync]"))) { b.disabled = true; post("/sync").then(function (r) { toast(r.skipped ? "Calendar isn't connected" : "Synced " + r.events + " events"); refresh(); }).catch(function (e2) { toast(e2.message); b.disabled = false; }); return; }
    if ((b = t.closest("[data-sqsync]"))) { var dn = busy(b, "Syncing…"); post("/money/square-sync").then(function (r) { toast(r.skipped || "Synced " + (r.payments || 0) + " payments"); RENDER.money(); }).catch(function (e2) { dn(); toast(e2.message, true); }); return; }
    if ((b = t.closest("[data-week]"))) { var n = +b.dataset.week; S.weekFrom = n ? addD(S.weekFrom, n) : weekStart(todayNY()); return RENDER.schedule(); }
    if (t.closest("[data-newblock]")) return openBlockSheet();
    if ((b = t.closest("[data-newjob]"))) return openBook({ customerId: b.dataset.cust, day: b.dataset.day, start: b.dataset.start });
    if (t.closest("[data-sheetbg]") && !t.closest(".sheet")) return closeSheet();
    if (t.closest("[data-close]")) return closeSheet();
    if ((b = t.closest("#bRep button"))) { [].forEach.call(b.parentNode.children, function (x) { x.setAttribute("aria-pressed", String(x === b)); }); var wk = b.dataset.v === "weekly"; document.getElementById("bOnce").hidden = wk; document.getElementById("bWeekly").hidden = !wk; return; }
    if ((b = t.closest("#bWd button"))) { b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true")); return; }
    if ((b = t.closest("[data-delblock]"))) { if (!confirm("Delete this blocked time?")) return; del("/blockouts/" + b.dataset.delblock).then(function () { toast("Deleted"); RENDER.schedule(); }).catch(function (e2) { toast(e2.message); }); return; }
    if ((b = t.closest("[data-skip]"))) { var wkly = b.dataset.weekly === "1"; if (!confirm(wkly ? "Skip it on " + dlabel(b.dataset.day) + " only?" : "Remove this blocked time?")) return;
      post("/blockouts/" + b.dataset.skip + "/skip", { day: b.dataset.day }).then(function () { toast(wkly ? "Skipped that day" : "Removed"); RENDER.schedule(); }).catch(function (e2) { toast(e2.message); }); return; }
    if ((b = t.closest("[data-scope]"))) { S.jobScope = b.dataset.scope; return RENDER.jobs(); }
    if ((b = t.closest("[data-people]"))) { S.people = b.dataset.people; S.archived = false; return PCACHE[S.people] ? drawPeople() : RENDER.people(); }
    if ((b = t.closest("[data-archived]"))) { S.archived = b.dataset.archived === "1"; return RENDER.people(); }
    // book sheet
    if (t.closest("[data-bknew]")) { BK.newCust = true; return drawBookCustomer(); }
    if (t.closest("[data-bkfind]")) { BK.newCust = false; return drawBookCustomer(); }
    if (t.closest("[data-bkchange]")) { BK.customer = null; BK.vehicles = []; drawVehicles(); drawBookCustomer(); return; }
    if ((b = t.closest("[data-bkpick]"))) { var c = (CUSTS || []).filter(function (x) { return x.id === b.dataset.bkpick; })[0]; if (c) pickCustomer(c); return; }
    if ((b = t.closest("#bkPkg button"))) { setPill("bkPkg", b.dataset.v); drawAdds(); if (!BK.edit) refreshPreview(); return; }
    if ((b = t.closest("#bkSize button"))) { setPill("bkSize", b.dataset.v); if (!BK.edit) refreshPreview(); return; }
    if ((b = t.closest("#bkAddP button"))) { var on2 = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on2)); BK.adds = [].map.call(document.querySelectorAll("#bkAddP [aria-pressed=true]"), function (x) { return x.dataset.v; }); if (!BK.edit) refreshPreview(); return; }
    if ((b = t.closest("#bkTimes button"))) { BK.start = +b.dataset.v; [].forEach.call(b.parentNode.children, function (x) { if (x.dataset) x.setAttribute("aria-pressed", String(x === b)); }); return; }
    if ((b = t.closest("#mvTimes button"))) { BK.start = +b.dataset.v; [].forEach.call(b.parentNode.children, function (x) { x.setAttribute("aria-pressed", String(x === b)); }); return; }
    if ((b = t.closest("#bkPay button"))) { [].forEach.call(b.parentNode.children, function (x) { x.setAttribute("aria-pressed", String(x === b)); }); return; }
    // job screen
    if ((b = t.closest("[data-jobact]"))) { var to = b.dataset.jobact; if (to === "done" && !confirm(JOB.kind === "member" ? "Mark this visit done?" : "Mark this job done? Then get paid below.")) return;
      var dn2 = busy(b); post("/jobs/" + JOB.id + "/status", { to: to }).then(function () { buzz(); renderJob(JOB.id); if (to === "done" && JOB.kind !== "member") setTimeout(function () { var p = document.getElementById("pay"); if (p) p.scrollIntoView({ behavior: "smooth" }); }, 400); }).catch(function (e2) { dn2(); toast(e2.message); }); return; }
    if (t.closest("[data-scrollpay]")) { e.preventDefault(); var p = document.getElementById("pay"); if (p) p.scrollIntoView({ behavior: "smooth" }); return; }
    if ((b = t.closest("[data-pay]"))) return doPay(b);
    if (t.closest("[data-payopen]")) { S.payOpen = true; drawJob(); var pp = document.getElementById("pay"); if (pp) pp.scrollIntoView({ behavior: "smooth" }); return; }
    if (t.closest("[data-jmove]")) return openMove();
    if (t.closest("[data-jcancel]")) return openCancel();
    if (t.closest("[data-jrefund]")) { if (!confirm("Did you already refund this in Square (Square app → Transactions → Refund)? This cancels the job and takes it out of your sales tax and income.")) return;
      post("/jobs/" + JOB.id + "/cancel", { reason: "refunded" }).then(function () { toast("Marked refunded"); renderJob(JOB.id); }).catch(function (e2) { toast(e2.message, true); }); return; }
    if (t.closest("[data-jedit]")) return openEditJob();
    if (t.closest("[data-jdel]")) { if (!confirm("Delete this job for good? Its photos are removed too.")) return; del("/jobs/" + JOB.id).then(function () { toast("Deleted"); JOB = null; goBack(); }).catch(function (e2) { toast(e2.message, true); }); return; }
    if ((b = t.closest("[data-savejnotes]"))) { var dn3 = busy(b, "Saving…"); post("/jobs/" + JOB.id + "/edit", { ownerNotes: document.getElementById("jNotes").value }).then(function () { dn3(); toast("Notes saved"); }).catch(function (e2) { dn3(); toast(e2.message); }); return; }
    // customer screen
    if (t.closest("[data-newcust]")) return openCustomer();
    if (t.closest("[data-editcust]")) return openCustomer(CUST.customer);
    if (t.closest("[data-delcust]")) { if (!confirm("Delete " + (CUST.customer.name || "this customer") + "? If they have past jobs, they're archived instead so your records stay.")) return;
      del("/customers/" + CUST.customer.id).then(function (r) { CUSTS = null; PCACHE = {}; toast(r.deleted ? "Deleted" : "Archived. Their records are kept.", true); go("#people"); }).catch(function (e2) { toast(e2.message, true); }); return; }
    if ((b = t.closest("[data-restore]"))) { post("/customers/" + b.dataset.restore + "/restore").then(function () { CUSTS = null; PCACHE = {}; toast("Restored"); renderCustomer(b.dataset.restore); }).catch(function (e2) { toast(e2.message); }); return; }
    if ((b = t.closest("[data-qnote]"))) { var ta = document.getElementById("cNotes"); ta.value = (ta.value ? ta.value.replace(/\s+$/, "") + "\n" : "") + b.dataset.qnote + ": "; ta.focus(); return; }
    if ((b = t.closest("[data-savecnotes]"))) { var dn4 = busy(b, "Saving…"); post("/customers/" + CUST.customer.id, { owner_notes: document.getElementById("cNotes").value }).then(function () { dn4(); toast("Notes saved"); }).catch(function (e2) { dn4(); toast(e2.message); }); return; }
    if (t.closest("[data-addveh]")) return openVehicle();
    if ((b = t.closest("[data-editveh]"))) return openVehicle(CUST.vehicles.filter(function (v) { return v.id === b.dataset.editveh; })[0]);
    if ((b = t.closest("[data-delveh]"))) { if (!confirm("Delete this vehicle? Past jobs and photos stay.")) return; del("/vehicles/" + b.dataset.delveh).then(function () { CUSTS = null; closeSheet(true); toast("Deleted"); renderCustomer(CUST.customer.id); }).catch(function (e2) { sheetErr(e2.message); }); return; }
    // member screen
    if ((b = t.closest("[data-mem]"))) {
      var act = b.dataset.mem;
      if (act === "resume") { if (!confirm("Resume this membership? The next charge is on its usual monthly date.")) return; post("/members/" + MEMB.member.id + "/resume").then(function (r) { toast(r.message, true); renderMember(MEMB.member.id); }).catch(function (e2) { toast(e2.message); }); return; }
      if (act === "retry") { var dn5 = busy(b, "Charging…"); post("/members/" + MEMB.member.id + "/retry").then(function (r) { toast(r.message, true); renderMember(MEMB.member.id); }).catch(function (e2) { dn5(); toast(e2.message, true); }); return; }
      return memSheet(act);
    }
    if (t.closest("[data-resetset]")) { if (!confirm("Put every setting back to the original defaults?")) return; post("/settings/reset").then(function () { toast("Reset"); RENDER.settings(); }).catch(function (e2) { toast(e2.message); }); return; }
    if (t.closest("[data-qretry]")) { if (window.ApexPhotos) window.ApexPhotos.retry(); toast("Retrying uploads"); return; }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target.matches && e.target.matches("[role=link][data-href]")) { e.preventDefault(); go(e.target.dataset.href); return; }
    if (e.key === "Escape" && sheetRoot.innerHTML) { closeSheet(); return; }
    if (e.key === "Tab" && sheetRoot.innerHTML) {   // keep focus inside the sheet
      var f = [].slice.call(sheetRoot.querySelectorAll("button, input, select, textarea, a[href]")).filter(function (x) { return !x.disabled && x.offsetParent !== null; });
      if (!f.length) return; var i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (i === -1 || i === f.length - 1)) { e.preventDefault(); f[0].focus(); }
    }
  });
  document.addEventListener("input", function (e) {
    var id = e.target.id;
    if (id === "pq") { S.q = e.target.value; drawPeople(); return; }
    if (id === "amt") return upPay();
    if (id === "bkQ") return drawResults(e.target.value);
    if (e.target.closest && e.target.closest("#cf")) { var f = e.target.closest("#cf"); f.querySelector('[type="submit"]').disabled = !f.name.value.trim(); }
    if (e.target.closest && e.target.closest("#setf")) { SH.dirty = true; memPrev(); }
  });
  document.addEventListener("change", function (e) {
    var id = e.target.id;
    if (id === "bAll") document.getElementById("bTimes").hidden = e.target.checked;
    if (id === "bkDay" || id === "bkDur") refreshPreview();
    if (id === "bkAny") { document.getElementById("bkAt").hidden = !e.target.checked; document.getElementById("bkTimes").style.opacity = e.target.checked ? ".4" : ""; }
    if (id === "mvAny") { document.getElementById("mvAt").hidden = !e.target.checked; document.getElementById("mvTimes").style.opacity = e.target.checked ? ".4" : ""; }
    if (id === "mvDay") moveTimes();
    if (id === "bkVeh") { BK.vehicleId = e.target.value; document.getElementById("bkNewVeh").hidden = e.target.value !== "new"; var v = BK.vehicles.filter(function (x) { return x.id === e.target.value; })[0]; if (v && v.size != null) { setPill("bkSize", String(v.size)); refreshPreview(); } }
    if (e.target.closest && e.target.closest("#msf")) planPrev();
    if (e.target.name === "town" && e.target.closest && e.target.closest("#bkNC")) refreshPreview();
  });
  document.addEventListener("submit", function (e) {
    var f = e.target; e.preventDefault();
    ({ bf: saveBlock, bkf: submitBook, mvf: submitMove, cxf: submitCancel, ejf: submitEditJob, cf: submitCustomer, vf: submitVehicle, msf: submitMem, setf: saveSettings }[f.id] || function () {})(f);
  });
  window.addEventListener("beforeunload", function (e) { if (SH.dirty && (sheetRoot.innerHTML || document.getElementById("setf"))) { e.preventDefault(); e.returnValue = ""; } });
  document.querySelector(".tabs").addEventListener("keydown", function (e) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    var bs = [].slice.call(document.querySelectorAll(".tabs button")), i = bs.findIndex(function (b) { return b.dataset.tab === S.tab; });
    var n = bs[(i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length]; e.preventDefault(); location.hash = "#" + n.dataset.tab; n.focus();
  });
  window.addEventListener("hashchange", route);
  // a cold start opens fresh: refresh the data when the app comes back to the front after a while
  var hiddenAt = 0;
  document.addEventListener("visibilitychange", function () { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 60000 && !sheetRoot.innerHTML && !document.getElementById("fsRoot").innerHTML) refresh(); });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/admin/sw.js", { scope: "/admin/" }).catch(function () {});
  route();
  api("/home").then(function (d) { syncLine(d.sync); }).catch(function () {});
})();
