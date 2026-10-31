// Reads Nick's iCloud calendars (busy times only) and writes jobs into his "Apex Jobs" calendar, over CalDAV.
// Login: Apple ID + an app-specific password, stored as Cloudflare secrets ICLOUD_USER / ICLOUD_APP_PASSWORD.
import ICAL from "ical.js";

const ROOT = "https://caldav.icloud.com/";

function auth(env) { return "Basic " + btoa(env.ICLOUD_USER + ":" + env.ICLOUD_APP_PASSWORD); }
export function calConfigured(env) { return !!(env.ICLOUD_USER && env.ICLOUD_APP_PASSWORD); }

async function dav(env, url, method, depth, body, extra) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ Authorization: auth(env), "Content-Type": "application/xml; charset=utf-8", Depth: String(depth) }, extra || {}),
    body
  });
  if (r.status === 401) throw new Error("iCloud login failed (check the Apple ID and app-specific password)");
  return r;
}

const tag = (xml, name) => { const m = xml.match(new RegExp("<(?:[A-Za-z0-9]+:)?" + name + "[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9]+:)?" + name + ">")); return m ? m[1] : null; };
const all = (xml, name) => xml.match(new RegExp("<(?:[A-Za-z0-9]+:)?" + name + "[^>]*>[\\s\\S]*?</(?:[A-Za-z0-9]+:)?" + name + ">", "g")) || [];
const href = xml => { const h = tag(xml, "href"); return h ? h.trim() : null; };
const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&amp;/g, "&");

// Find the calendar list. Cached in the database for a day.
export async function calendars(env, fresh) {
  if (!fresh) {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'calendars'").first();
    if (row) { const c = JSON.parse(row.v); if (Date.now() - c.at < 864e5) return c.list; }
  }
  let r = await dav(env, ROOT, "PROPFIND", 0, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>');
  let x = await r.text();
  const principal = href(tag(x, "current-user-principal") || "");
  if (!principal) throw new Error("iCloud: no principal (" + r.status + ")");
  r = await dav(env, new URL(principal, ROOT).href, "PROPFIND", 0, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>');
  x = await r.text();
  const home = new URL(href(tag(x, "calendar-home-set") || ""), ROOT).href;
  r = await dav(env, home, "PROPFIND", 1, '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>');
  x = await r.text();
  const list = [];
  for (const resp of all(x, "response")) {
    const rt = tag(resp, "resourcetype") || "";
    if (!/calendar/.test(rt)) continue;
    const comps = tag(resp, "supported-calendar-component-set") || "";
    if (comps && !/VEVENT/.test(comps)) continue;
    list.push({ href: new URL(href(resp), home).href, name: decode((tag(resp, "displayname") || "").trim()) });
  }
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('calendars', ?)").bind(JSON.stringify({ at: Date.now(), list })).run();
  return list;
}

const icalTime = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// All busy intervals between fromMs and toMs. Ignores titles; returns [{start_utc,end_utc,all_day,kind}]
export async function readBusy(env, fromMs, toMs) {
  const ignore = (env.IGNORE_CALENDARS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const jobsName = (env.JOBS_CALENDAR || "Apex Jobs").toLowerCase(), blockName = (env.BLOCK_CALENDAR || "Apex Blocked").toLowerCase();
  const out = [], seen = [];
  for (const cal of await calendars(env)) {
    const nm = cal.name.toLowerCase();
    if (ignore.includes(nm)) continue;
    const kind = nm === jobsName ? "job" : nm === blockName ? "blocked" : "event";
    const body = '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop>' +
      '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="' + icalTime(fromMs) + '" end="' + icalTime(toMs) + '"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
    const r = await dav(env, cal.href, "REPORT", 1, body);
    if (r.status >= 400) continue;
    const x = await r.text();
    seen.push(cal.name);
    for (const resp of all(x, "response")) {
      const data = tag(resp, "calendar-data"); if (!data) continue;
      try { collect(decode(data.replace(/^<!\[CDATA\[|\]\]>$/g, "")), fromMs, toMs, kind, out); } catch (e) { /* skip anything we can't read */ }
    }
  }
  return { busy: out, calendars: seen };
}

export function collect(ics, fromMs, toMs, kind, out) {
  const vcal = new ICAL.Component(ICAL.parse(ics));
  for (const tz of vcal.getAllSubcomponents("vtimezone")) { try { ICAL.TimezoneService.register(new ICAL.Timezone(tz)); } catch (e) {} }
  const evs = vcal.getAllSubcomponents("vevent"), byUid = {};
  for (const v of evs) { const uid = v.getFirstPropertyValue("uid") || Math.random() + ""; (byUid[uid] = byUid[uid] || []).push(v); }
  for (const uid in byUid) {
    if (/^apex-/.test(uid)) continue;   // jobs we booked ourselves are counted from the database, whichever calendar they sit in
    const list = byUid[uid], main = list.find(v => !v.hasProperty("recurrence-id")) || list[0];
    const ev = new ICAL.Event(main);
    for (const v of list) if (v !== main && v.hasProperty("recurrence-id")) { try { ev.relateException(v); } catch (e) {} }
    const push = (s, e, item) => {
      const comp = item.component;
      if ((comp.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED") return;
      if ((comp.getFirstPropertyValue("transp") || "").toUpperCase() === "TRANSPARENT") return;
      const allDay = s.isDate, sm = s.toJSDate().getTime(), em = e ? e.toJSDate().getTime() : sm + (allDay ? 864e5 : 0);
      if (em <= fromMs || sm >= toMs) return;
      out.push({ start_utc: sm, end_utc: em, all_day: allDay ? 1 : 0, kind });
    };
    if (ev.isRecurring()) {
      const it = ev.iterator(); let next, n = 0;
      while ((next = it.next()) && n++ < 1000) {
        if (next.toJSDate().getTime() >= toMs) break;
        const det = ev.getOccurrenceDetails(next);
        push(det.startDate, det.endDate, det.item);
      }
    } else push(ev.startDate, ev.endDate, ev);
  }
}

function esc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;"); }
function fold(line) { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = " " + line.slice(74); } out.push(line); return out.join("\r\n"); }

export function jobIcs(b, opts) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apex Detailing//Bookings//EN", "BEGIN:VEVENT",
    "UID:apex-" + b.id + "@apexdetailingoc.com", "DTSTAMP:" + icalTime(Date.now()), "DTSTART:" + icalTime(b.start_utc), "DTEND:" + icalTime(b.end_utc),
    "SUMMARY:" + esc(opts.summary), "LOCATION:" + esc(opts.location), "DESCRIPTION:" + esc(opts.description)];
  if (opts.url) lines.push("URL:" + opts.url);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}

// Put (or replace) a job in the Apex Jobs calendar. Returns the event URL, or null if that calendar doesn't exist yet.
export async function writeJob(env, b, opts) {
  const cal = (await calendars(env)).find(c => c.name.toLowerCase() === (env.JOBS_CALENDAR || "Apex Jobs").toLowerCase());
  if (!cal) return null;
  const url = b.cal_href || (cal.href.replace(/\/?$/, "/") + "apex-" + b.id + ".ics");
  const r = await fetch(url, { method: "PUT", headers: { Authorization: auth(env), "Content-Type": "text/calendar; charset=utf-8" }, body: jobIcs(b, opts) });
  if (r.status >= 400) throw new Error("iCloud: couldn't save the job (" + r.status + ")");
  return url;
}

export async function deleteJob(env, url) {
  if (!url) return;
  await fetch(url, { method: "DELETE", headers: { Authorization: auth(env) } });
}
