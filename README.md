# Apex Detailing — website + booking backend

Mobile car detailing in Brick & Ocean County, NJ. Runs on Cloudflare Workers.

- `public/` — the website (single-page `index.html`, photos, 3D car models)
- `src/worker.js` — API + pages: `/api/days` (open times), `/api/book`, `/b/<token>` (customer manage link), `/ack/<token>` (owner "Got it")
- `src/sched.js` — scheduling rules (hours, sunset, 1-hour gaps, 24-hour notice, jobs per day, winter mode). The website runs a copy of `slotsFor()`.
- `src/cal.js` — reads busy times from iCloud Calendar and writes jobs to the "Apex Jobs" calendar (CalDAV)
- `src/email.js` — booking emails via Resend
- `migrations/` — database tables (Cloudflare D1)

Secrets are set in the Cloudflare dashboard, never in this repo: `ICLOUD_USER`, `ICLOUD_APP_PASSWORD`, `RESEND_API_KEY`.

Deploy: `npm run deploy` (applies database migrations, then deploys).
