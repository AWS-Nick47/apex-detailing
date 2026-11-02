// Settings Nick can change from the owner dashboard (hours, job lengths, prices, launch sale, travel fees, membership prices).
// They're saved in meta('settings') and applied on top of the defaults in sched.js / pricing.js / membership.js at the
// start of every request (cached for 20 seconds per Worker instance), so the site and the server always agree.
// Rules that are written into the Terms (24-hour changes, 3-month minimum, cancel fee, skip credit, sign-up window) and the
// travel-zone distances (drawn on the site's map) are NOT editable here: changing them means updating the Terms or the map.
import { RULES } from "./sched.js";
import { PRICING } from "./pricing.js";
import { MEM } from "./membership.js";

const clone = o => JSON.parse(JSON.stringify(o));
const PK = ["exterior", "interior", "full"], ADD = ["pet", "stain", "lights", "engine"], PLANS = ["wash", "int", "both"];
const DEF = { rules: clone(RULES), pricing: clone(PRICING), plans: clone(MEM.plans), freqDiscount: clone(MEM.freqDiscount) };
const NEVER = { start: [1, 1], end: [1, 1] };   // start == end: no winter at all

let cache = { at: 0, raw: null };

// Put the saved settings on top of the defaults (in place: every module holds the same objects)
function apply(s) {
  const r = DEF.rules, p = DEF.pricing;
  Object.assign(RULES, { startMin: r.startMin, latestEnd: r.latestEnd, bySunset: r.bySunset, gapMin: r.gapMin, stepMin: r.stepMin, maxJobs: r.maxJobs, maxJobsDayOff: r.maxJobsDayOff,
    horizonDays: r.horizonDays, winter: clone(r.winter), baseMin: clone(r.baseMin), addonMin: clone(r.addonMin), memberLessMin: clone(r.memberLessMin) });
  Object.assign(PRICING, { launchSale: p.launchSale, regular: clone(p.regular), launch: clone(p.launch), addons: clone(p.addons), memberAddonDiscount: p.memberAddonDiscount, zones: clone(p.zones) });
  for (const k of PLANS) MEM.plans[k].pct = DEF.plans[k].pct;
  Object.assign(MEM.freqDiscount, clone(DEF.freqDiscount));
  if (!s) return;
  const sr = s.rules || {}, sp = s.pricing || {}, sm = s.mem || {};
  for (const k of ["startMin", "latestEnd", "bySunset", "gapMin", "stepMin", "maxJobs", "maxJobsDayOff", "horizonDays"]) if (sr[k] != null) RULES[k] = sr[k];
  if (sr.winter) RULES.winter = sr.winterOn === false ? clone(NEVER) : clone(sr.winter);
  for (const k of ["baseMin", "addonMin", "memberLessMin"]) if (sr[k]) RULES[k] = clone(sr[k]);
  for (const k of ["launchSale", "memberAddonDiscount"]) if (sp[k] != null) PRICING[k] = sp[k];
  for (const k of ["regular", "launch", "addons"]) if (sp[k]) PRICING[k] = clone(sp[k]);
  if (Array.isArray(sp.zoneFees)) PRICING.zones = DEF.pricing.zones.map((z, i) => ({ max: z.max, fee: sp.zoneFees[i] != null ? sp.zoneFees[i] : z.fee }));
  if (sm.pct) for (const k of PLANS) if (sm.pct[k] != null) MEM.plans[k].pct = sm.pct[k];
  if (sm.freqDiscount) for (const k of ["2", "4"]) if (sm.freqDiscount[k] != null) MEM.freqDiscount[k] = sm.freqDiscount[k];
}

export async function loadSettings(env, force) {
  if (!env || !env.DB) return cache.raw;
  if (!force && cache.at && Date.now() - cache.at < 20000) return cache.raw;
  try {
    const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'settings'").first();
    const raw = row ? JSON.parse(row.v) : null;
    apply(raw); cache = { at: Date.now(), raw };
  } catch (e) { console.log("settings load failed, using the last good ones", e.message); }
  return cache.raw;
}

// what the dashboard edits: the values in force now, the defaults, and what's locked (and why)
export function currentSettings() {
  const w = RULES.winter, on = !(w.start[0] === w.end[0] && w.start[1] === w.end[1]), saved = cache.raw && cache.raw.rules && cache.raw.rules.winter;
  return {
    rules: { startMin: RULES.startMin, latestEnd: RULES.latestEnd, bySunset: RULES.bySunset, gapMin: RULES.gapMin, stepMin: RULES.stepMin, maxJobs: RULES.maxJobs, maxJobsDayOff: RULES.maxJobsDayOff,
      horizonDays: RULES.horizonDays, winterOn: on, winter: on ? clone(w) : clone(saved || DEF.rules.winter), baseMin: clone(RULES.baseMin), addonMin: clone(RULES.addonMin), memberLessMin: clone(RULES.memberLessMin) },
    pricing: { launchSale: PRICING.launchSale, regular: clone(PRICING.regular), launch: clone(PRICING.launch), addons: clone(PRICING.addons), memberAddonDiscount: PRICING.memberAddonDiscount, zones: clone(PRICING.zones) },
    mem: { pct: Object.fromEntries(PLANS.map(k => [k, MEM.plans[k].pct])), freqDiscount: { 2: MEM.freqDiscount[2], 4: MEM.freqDiscount[4] } },
    locked: { noticeHours: RULES.noticeHours, maxMiles: RULES.maxMiles, zoneMiles: PRICING.zones.map(z => z.max), minPayments: MEM.minPayments, cancelFeeRate: MEM.cancelFeeRate, skipCreditRate: MEM.skipCreditRate,
      skipNoticeHours: MEM.skipNoticeHours, signupDays: MEM.signupDays, taxRate: "6.625%" },
    changed: !!cache.raw, updatedAt: cache.raw && cache.raw.updatedAt || null
  };
}

// the subset the public website needs (injected into the home page by the Worker)
export function publicSettings() {
  return { pricing: { launchSale: PRICING.launchSale, regular: PRICING.regular, launch: PRICING.launch, addons: PRICING.addons, memberAddonDiscount: PRICING.memberAddonDiscount,
      membership: Object.fromEntries(PLANS.map(k => [k, { of: MEM.plans[k].of, pct: MEM.plans[k].pct }])), freqDiscount: MEM.freqDiscount },
    sched: { winter: RULES.winter, baseMin: RULES.baseMin, addonMin: RULES.addonMin, zones: PRICING.zones } };
}

// ---------- validation ----------
function int(v, lo, hi, step, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n) throw new Error(what + " must be a whole number.");
  if (n < lo || n > hi) throw new Error(what + " must be between " + lo + " and " + hi + ".");
  if (step && n % step) throw new Error(what + " must be in steps of " + step + ".");
  return n;
}
function rate(v, lo, hi, what) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(what + " must be between " + Math.round(lo * 100) + "% and " + Math.round(hi * 100) + "%.");
  return Math.round(n * 1000) / 1000;
}
function md(a, what) {
  if (!Array.isArray(a) || a.length !== 2) throw new Error(what + ": pick a month and day.");
  const m = int(a[0], 1, 12, 0, what + " month"), d = int(a[1], 1, 31, 0, what + " day");
  if (d > new Date(Date.UTC(2024, m, 0)).getUTCDate()) throw new Error(what + ": that day doesn't exist.");
  return [m, d];
}
const NAMES = { exterior: "Exterior", interior: "Interior", full: "Full Detail" }, SZ = ["Sedan", "SUV", "Truck"], AN = { pet: "Heavy pet hair", stain: "Heavy stain or odor", lights: "Headlight restoration", engine: "Engine bay" };

export function validate(input) {
  const i = input || {}, ir = i.rules || {}, ip = i.pricing || {}, im = i.mem || {};
  const cur = currentSettings(), r = {}, p = {}, m = {};
  const g = (o, k, d) => (o[k] === undefined ? d : o[k]);
  r.startMin = int(g(ir, "startMin", cur.rules.startMin), 300, 720, 15, "Earliest start");
  r.latestEnd = int(g(ir, "latestEnd", cur.rules.latestEnd), 720, 1320, 15, "Done by");
  if (r.latestEnd - r.startMin < 180) throw new Error("The working day must be at least 3 hours.");
  r.bySunset = !!g(ir, "bySunset", cur.rules.bySunset);
  r.gapMin = int(g(ir, "gapMin", cur.rules.gapMin), 0, 180, 15, "Buffer");
  r.stepMin = int(g(ir, "stepMin", cur.rules.stepMin), 15, 60, 15, "Start times every");
  if (![15, 30, 60].includes(r.stepMin)) throw new Error("Start times every 15, 30 or 60 minutes.");
  r.maxJobs = int(g(ir, "maxJobs", cur.rules.maxJobs), 1, 4, 0, "Jobs per day");
  r.maxJobsDayOff = int(g(ir, "maxJobsDayOff", cur.rules.maxJobsDayOff), 1, 4, 0, "Jobs on a day off");
  if (r.maxJobsDayOff < r.maxJobs) throw new Error("Jobs on a full day off can't be fewer than on a normal day.");
  r.horizonDays = int(g(ir, "horizonDays", cur.rules.horizonDays), 7, 180, 0, "Booking window");
  r.winterOn = !!g(ir, "winterOn", cur.rules.winterOn);
  const w = g(ir, "winter", cur.rules.winter) || {};
  r.winter = { start: md(w.start, "Winter starts"), end: md(w.end, "Winter ends") };
  if (r.winterOn && r.winter.start[0] === r.winter.end[0] && r.winter.start[1] === r.winter.end[1]) throw new Error("Winter can't start and end on the same day.");
  const bm = g(ir, "baseMin", cur.rules.baseMin); r.baseMin = {};
  for (const k of PK) r.baseMin[k] = [0, 1, 2].map(s => int((bm[k] || [])[s], 30, 720, 15, NAMES[k] + " " + SZ[s] + " length (minutes)"));
  const am = g(ir, "addonMin", cur.rules.addonMin); r.addonMin = {};
  for (const k of ADD) r.addonMin[k] = int(am[k], 0, 240, 5, AN[k] + " extra time");
  const ml = g(ir, "memberLessMin", cur.rules.memberLessMin); r.memberLessMin = {};
  for (const k of PK) { r.memberLessMin[k] = int(ml[k], 0, 240, 15, "Member visit time saved (" + NAMES[k] + ")"); if (r.memberLessMin[k] >= Math.min(...r.baseMin[k])) throw new Error("Member " + NAMES[k] + " visits would take no time. Lower the time saved."); }

  p.launchSale = !!g(ip, "launchSale", cur.pricing.launchSale);
  for (const t of ["regular", "launch"]) {
    const tb = g(ip, t, cur.pricing[t]); p[t] = {};
    for (const k of PK) p[t][k] = [0, 1, 2].map(s => int((tb[k] || [])[s], 0, 2000, 0, (t === "launch" ? "Launch " : "") + NAMES[k] + " " + SZ[s] + " price"));
  }
  for (const k of PK) for (const s of [0, 1, 2]) {
    if (p.regular[k][s] < 20) throw new Error(NAMES[k] + " " + SZ[s] + " price looks too low.");
    if (p.launch[k][s] > p.regular[k][s]) throw new Error("The launch price for " + NAMES[k] + " " + SZ[s] + " is higher than the regular price.");
  }
  const ad = g(ip, "addons", cur.pricing.addons); p.addons = {};
  for (const k of ADD) p.addons[k] = int(ad[k], 0, 1000, 0, AN[k] + " price");
  p.memberAddonDiscount = rate(g(ip, "memberAddonDiscount", cur.pricing.memberAddonDiscount), 0, 0.5, "Member add-on discount");
  const zf = g(ip, "zoneFees", cur.pricing.zones.map(z => z.fee));
  p.zoneFees = DEF.pricing.zones.map((z, n) => int(zf[n], 0, 300, 0, "Travel fee up to " + z.max + " mi"));

  const pc = g(im, "pct", cur.mem.pct); m.pct = {};
  for (const k of PLANS) m.pct[k] = rate(pc[k], 0.1, 1, MEM.plans[k].name + " plan price");
  const fd = g(im, "freqDiscount", cur.mem.freqDiscount);
  m.freqDiscount = { 2: rate(fd[2], 0, 0.5, "Every-2-weeks discount"), 4: rate(fd[4], 0, 0.5, "Weekly discount") };
  return { rules: r, pricing: p, mem: m };
}

export async function saveSettings(env, input, who) {
  const s = validate(input); s.updatedAt = Date.now(); s.by = who || null;
  await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('settings', ?)").bind(JSON.stringify(s)).run();
  await loadSettings(env, true);
  return currentSettings();
}
export async function resetSettings(env) {
  await env.DB.prepare("DELETE FROM meta WHERE k = 'settings'").run();
  await loadSettings(env, true);
  return currentSettings();
}
