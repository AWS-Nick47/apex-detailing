// Scheduling rules for Apex Detailing. The website runs a copy of slotsFor() so the picker is instant;
// the server runs this one again when someone books, so the server always has the final say.

export const RULES = {
  tz: "America/New_York",
  startMin: 8 * 60,          // earliest start, 8:00 AM
  latestEnd: 19 * 60,        // must be done by 7:00 PM ...
  bySunset: true,            // ... or by sundown, whichever is earlier
  gapMin: 60,                // free time before/after every calendar event and between jobs
  noticeHours: 24,           // customers must book at least this far ahead
  stepMin: 30,               // start times every 30 minutes
  maxJobs: 1,                // jobs per day normally
  maxJobsDayOff: 2,          // jobs per day when the calendar is otherwise empty
  horizonDays: 60,           // how far ahead people can book
  winter: { start: [12, 15], end: [3, 1] },   // [month, day]: Interior only
  baseMin: { exterior: [90, 90, 150], interior: [210, 210, 210], full: [300, 300, 360] },
  addonMin: { pet: 40, stain: 40, lights: 45, engine: 30 },
  addonPkgs: { pet: ["interior", "full"], stain: ["interior", "full"], lights: ["exterior", "interior", "full"], engine: ["exterior", "interior", "full"] },
  home: [40.060, -74.120],
  maxMiles: 30
};

export function jobMin(pkg, size, adds) {
  const m = RULES.baseMin[pkg][size] + (adds || []).reduce((t, id) => t + (RULES.addonMin[id] || 20), 0);
  return Math.round(m / 15) * 15;
}

export function inWinter(y, m, d) {
  const v = m * 100 + d, s = RULES.winter.start, e = RULES.winter.end, sv = s[0] * 100 + s[1], ev = e[0] * 100 + e[1];
  return sv > ev ? (v >= sv || v < ev) : (v >= sv && v < ev);
}

// minutes to add to UTC to get New York local time at this instant (-300 or -240)
export function nyOffsetMin(utcMs) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: RULES.tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(utcMs)).reduce((o, x) => (o[x.type] = x.value, o), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((asUtc - Math.floor(utcMs / 60000) * 60000) / 60000);
}

export function parseDay(key) { const [y, m, d] = key.split("-").map(Number); return { y, m, d }; }
export function dayKey(y, m, d) { return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0"); }

// UTC ms for a New York local time on a given day
export function nyToUtc(key, minutes) {
  const { y, m, d } = parseDay(key);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let off = nyOffsetMin(guess - 5 * 3600e3);
  let t = guess - off * 60000;
  const off2 = nyOffsetMin(t); if (off2 !== off) t = guess - off2 * 60000;
  return t;
}

// New York day key + minutes after midnight for a UTC instant
export function utcToNy(utcMs) {
  const local = new Date(utcMs + nyOffsetMin(utcMs) * 60000);
  return { key: dayKey(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate()), min: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function addDays(key, n) { const { y, m, d } = parseDay(key); const t = new Date(Date.UTC(y, m - 1, d + n)); return dayKey(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }

// sunset in minutes after local midnight (New York) for Brick, NJ — same formula the website uses
export function sunsetMin(key) {
  const { y, m, d } = parseDay(key);
  const rad = Math.PI / 180, lat = RULES.home[0], lon = RULES.home[1];
  const N = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
  const lngHour = lon / 15, t = N + ((18 - lngHour) / 24), M = 0.9856 * t - 3.289;
  const L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634 + 360) % 360;
  let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 360) % 360; RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad), cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
  const H = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad / 15, T = H + RA - 0.06571 * t - 6.622, UT = ((T - lngHour) % 24 + 24) % 24;
  const off = nyOffsetMin(Date.UTC(y, m - 1, d, 17)) / 60;
  return Math.round(((UT + off + 24) % 24) * 60);
}

// Summarize one day for the picker. busy = [{start_utc,end_utc,all_day,kind}], jobs = [{start_utc,end_utc}]
// Returns { b: [[from,to],...] blocked minutes (gap already added), j: jobs that day, off: day off?, end: latest finish }
export function dayInfo(key, busy, jobs) {
  const d0 = nyToUtc(key, 0), d1 = nyToUtc(addDays(key, 1), 0), span = (d1 - d0) / 60000;
  const blocks = []; let events = 0, j = 0;
  const clip = (s, e) => [Math.max(0, Math.round((s - d0) / 60000)), Math.min(span, Math.round((e - d0) / 60000))];
  for (const r of busy) {
    if (r.end_utc <= d0 - RULES.gapMin * 60000 || r.start_utc >= d1 + RULES.gapMin * 60000) continue;
    if (r.all_day) { if (r.kind === "blocked" && r.start_utc < d1 && r.end_utc > d0) blocks.push([0, span]); continue; }   // all-day events in normal calendars don't block
    const [s, e] = clip(r.start_utc, r.end_utc);
    blocks.push([s - RULES.gapMin, e + RULES.gapMin]);
    if (r.start_utc < d1 && r.end_utc > d0) { if (r.kind === "job") j++; else events++; }
  }
  for (const b of jobs) {
    if (b.end_utc <= d0 - RULES.gapMin * 60000 || b.start_utc >= d1 + RULES.gapMin * 60000) continue;
    const [s, e] = clip(b.start_utc, b.end_utc);
    blocks.push([s - RULES.gapMin, e + RULES.gapMin]);
    if (b.start_utc < d1 && b.end_utc > d0) j++;
  }
  let end = RULES.latestEnd;
  if (RULES.bySunset) end = Math.min(end, Math.floor(sunsetMin(key) / 15) * 15);
  return { b: merge(blocks), j, off: events === 0, end };
}

function merge(list) {
  list.sort((a, b) => a[0] - b[0]); const out = [];
  for (const x of list) { const last = out[out.length - 1]; if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
}

// Open start times (minutes after midnight) for a job on a day
export function slotsFor(key, info, pkg, size, adds, nowMs) {
  const { y, m, d } = parseDay(key);
  if (pkg !== "interior" && inWinter(y, m, d)) return [];
  if (info.j >= (info.off ? RULES.maxJobsDayOff : RULES.maxJobs)) return [];
  const len = jobMin(pkg, size, adds), earliest = nowMs + RULES.noticeHours * 3600e3, out = [];
  for (let t = RULES.startMin; t + len <= info.end; t += RULES.stepMin) {
    if (nyToUtc(key, t) < earliest) continue;
    if (info.b.every(b => t + len <= b[0] || t >= b[1])) out.push(t);
  }
  return out;
}

export function milesFromHome(lat, lon) {
  const R = 3958.8, rad = Math.PI / 180, h = RULES.home, dLat = (lat - h[0]) * rad, dLon = (lon - h[1]) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(h[0] * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
