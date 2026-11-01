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
  memberLessMin: { exterior: 0, interior: 60, full: 60 },   // Apex Membership upkeep visits are shorter than a first detail
  addonPkgs: { pet: ["interior", "full"], stain: ["interior", "full"], lights: ["exterior", "interior", "full"], engine: ["exterior", "interior", "full"] },
  home: [40.060, -74.120],
  maxMiles: 30
};

export function jobMin(pkg, size, adds) {
  const m = RULES.baseMin[pkg][size] + (adds || []).reduce((t, id) => t + (id === "_member" ? -(RULES.memberLessMin[pkg] || 0) : (RULES.addonMin[id] || 20)), 0);
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
  // wall-clock minutes (what slotsFor uses), so DST days don't shift busy times by an hour (audit IA-020)
  const wall = ms => ms <= d0 ? 0 : ms >= d1 ? 1440 : utcToNy(ms).min;
  const clip = (s, e) => [wall(s), wall(e)];
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

// Service-area towns (approximate centers), same list as the website (TOWNS in public/index.html).
// Used to place a booking when the customer didn't pick an exact address. Audit IA-009.
export const TOWNS = { "Brick": [40.060, -74.137], "Point Pleasant": [40.083, -74.068], "Point Pleasant Beach": [40.091, -74.048], "Bay Head": [40.071, -74.046], "Mantoloking": [40.040, -74.051], "Lavallette": [39.970, -74.069], "Seaside Heights": [39.944, -74.073], "Seaside Park": [39.926, -74.077], "Toms River": [39.954, -74.198], "Beachwood": [39.939, -74.193], "Pine Beach": [39.936, -74.172], "Ocean Gate": [39.926, -74.134], "Island Heights": [39.942, -74.150], "Bayville": [39.909, -74.155], "Berkeley Township": [39.897, -74.183], "Lakewood": [40.098, -74.218], "Jackson": [40.098, -74.357], "Howell": [40.181, -74.193], "Wall": [40.168, -74.091], "Manasquan": [40.126, -74.049], "Brielle": [40.108, -74.057], "Sea Girt": [40.132, -74.035], "Spring Lake": [40.153, -74.028], "Belmar": [40.178, -74.022], "Farmingdale": [40.197, -74.169], "Lakehurst": [40.015, -74.311], "Manchester": [39.996, -74.355], "Forked River": [39.840, -74.190], "Lacey": [39.860, -74.226], "Waretown": [39.791, -74.195], "Barnegat": [39.753, -74.223], "Manahawkin": [39.695, -74.259], "Stafford": [39.705, -74.264], "Ship Bottom": [39.643, -74.180], "Neptune": [40.200, -74.028], "Asbury Park": [40.220, -74.012], "Ocean Township": [40.250, -74.030], "Long Branch": [40.304, -73.992], "Freehold": [40.260, -74.274], "Red Bank": [40.347, -74.064], "Middletown": [40.395, -74.092], "Holmdel": [40.345, -74.184], "Marlboro": [40.315, -74.246], "Tuckerton": [39.603, -74.340], "New Egypt": [40.067, -74.531], "Princeton": [40.357, -74.667], "New Brunswick": [40.486, -74.452], "Trenton": [40.221, -74.756], "Atlantic City": [39.364, -74.423], "Edison": [40.519, -74.412] };
export function townCoords(town) {
  const v = String(town || "").trim().toLowerCase().replace(/,?\s*(nj|new jersey)$/, "").replace(/ (twp|township|boro|borough)$/, "");
  const hit = Object.keys(TOWNS).find(k => k.toLowerCase() === v);
  return hit ? TOWNS[hit] : null;
}

export function milesFromHome(lat, lon) {
  const R = 3958.8, rad = Math.PI / 180, h = RULES.home, dLat = (lat - h[0]) * rad, dLon = (lon - h[1]) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(h[0] * rad) * Math.cos(lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
