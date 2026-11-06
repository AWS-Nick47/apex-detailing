// A job finished before its booked time is up (Nick often goes early): the booking moves to when it really happened
// (started -> finished), so the booked time opens up again, the customer's account and Nick's lists show it as done,
// no "see you tomorrow" reminder goes out, the Apex Jobs calendar event moves, and a membership started from it counts
// from the real day. The booked time is kept in the booking's history; "Not done" right after puts it back.
import { utcToNy } from "./sched.js";
import { moveWithDetail } from "./membership.js";

async function applyTime(env, b, start, end, hist, calSave) {
  const day = utcToNy(start).key;
  await env.DB.prepare("UPDATE bookings SET start_utc = ?, end_utc = ?, day = ?, history = ? WHERE id = ?").bind(start, end, day, JSON.stringify(hist), b.id).run();
  Object.assign(b, { start_utc: start, end_utc: end, day, history: JSON.stringify(hist) });
  const tasks = [];
  if (b.cal_href && calSave) tasks.push(Promise.resolve().then(() => calSave(b)).catch(e => console.log("calendar move failed", e.message)));
  if (b.kind !== "member") tasks.push(moveWithDetail(env, b).catch(e => console.log("membership move failed", e.message)));
  await Promise.all(tasks);
  return day;
}

// call right after a job becomes done at `now`; returns the new day, or null when it finished at or after its booked end
export async function finishedEarly(env, b, now, calSave) {
  if (b.status !== "confirmed" || !(now < b.end_utc)) return null;
  const len = Math.max(15 * 60000, b.end_utc - b.start_utc), started = b.started_at && b.started_at < now ? b.started_at : null;
  const start = now < b.start_utc ? (started || now - len) : Math.min(b.start_utc, started || b.start_utc);
  const hist = JSON.parse(b.history || "[]"); hist.push({ at: now, from: b.start_utc, end: b.end_utc, day: b.day, why: "done_early" });
  return applyTime(env, b, start, now, hist, calSave);
}

// "Not done" right after an early Done: back to the booked time, if that's still ahead
export async function backToBooked(env, b, calSave) {
  const hist = JSON.parse(b.history || "[]"), last = hist[hist.length - 1];
  if (!last || last.why !== "done_early" || !(last.end > Date.now())) return null;
  hist.pop();
  return applyTime(env, b, last.from, last.end, hist, calSave);
}
