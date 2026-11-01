import re, os
root = os.path.dirname(os.path.abspath(__file__))
site = open(os.path.join(root, '..', 'apex', 'index.html')).read()
i = site.index('<svg class="logo"'); logo = site[i:site.index('</svg>', i) + 6]
UPDATED = "November 1, 2026"
VERSION = "2026-11-01"

def page(slug, title, intro, body):
    nav = ' · '.join(f'<a href="/{s}"{" aria-current=\"page\"" if s == slug else ""}>{t}</a>' for s, t in [("terms", "Terms of Service"), ("membership-terms", "Membership Terms"), ("privacy", "Privacy Policy")])
    return f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Apex Detailing</title><link rel="canonical" href="https://apexdetailingoc.com/{slug}"><meta name="description" content="{title} for Apex Detailing LLC, mobile car detailing in Brick and Ocean County, NJ.">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23000'/%3E%3Cg transform='translate(4 4)'%3E%3Cpath d='M2 20 L10 6 L13 11 L15.5 8 L22 20 Z' fill='none' stroke='%23fff' stroke-width='1.8' stroke-linejoin='round'/%3E%3Cpath d='M8.3 9 L10 6 L11.8 9.2 L10 8.4 Z' fill='%23fff'/%3E%3C/g%3E%3C/svg%3E">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root {{ color-scheme: dark; --bg:#0a0a0a; --fg:#ededed; --muted:#a3a3a3; --line:rgba(255,255,255,.1); }}
html {{ background: var(--bg); }}
body {{ margin:0; background:var(--bg); color:var(--fg); font: 17px/1.65 -apple-system,"SF Pro Text",system-ui,"Segoe UI",sans-serif; -webkit-font-smoothing: antialiased; }}
.w {{ max-width: 760px; margin: 0 auto; padding: 28px 16px 80px; }}
.top {{ display:flex; justify-content:space-between; align-items:center; gap:12px; padding-bottom:18px; border-bottom:1px solid var(--line); }}
.brand {{ color: var(--fg); display:inline-flex; }} .brand svg {{ height: 16px; width: auto; }}
.back {{ color: var(--muted); font-size: 14px; text-decoration: none; }} .back:hover {{ color: var(--fg); }}
h1 {{ font-size: clamp(30px, 6vw, 42px); line-height:1.1; letter-spacing:-.02em; margin: 34px 0 6px; }}
.meta {{ color: var(--muted); font-size: 14px; margin: 0 0 22px; }}
.lede {{ font-size: 18px; color: #d6d6d6; }}
.docnav {{ font-size: 14px; color: var(--muted); margin: 0 0 30px; }} .docnav a {{ color: var(--muted); }} .docnav a[aria-current] {{ color: var(--fg); font-weight:600; text-decoration:none; }}
h2 {{ font-size: 21px; letter-spacing:-.01em; margin: 38px 0 8px; padding-top: 6px; }}
h3 {{ font-size: 17px; margin: 22px 0 4px; }}
p, li {{ color: #d6d6d6; }} ul {{ padding-left: 22px; }} li {{ margin: 4px 0; }}
a {{ color: var(--fg); }}
.box {{ background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1px var(--line); border-radius: 16px; padding: 4px 18px; margin: 18px 0; }}
.toc {{ columns: 2; column-gap: 28px; font-size: 15px; padding-left: 0; list-style: none; }} .toc a {{ color: #cfcfcf; }}
@media (max-width: 560px) {{ .toc {{ columns: 1; }} }}
footer {{ margin-top: 48px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 14px; }}
</style></head>
<body><div class="w">
<div class="top"><a class="brand" href="/" aria-label="Apex Detailing home">{logo}</a><a class="back" href="/">← Back to site</a></div>
<h1>{title}</h1>
<p class="meta">Apex Detailing LLC · Last updated {UPDATED}</p>
<p class="docnav">{nav}</p>
<main>
{intro}
{body}
</main>
<footer>Apex Detailing LLC · Mobile car detailing in Brick &amp; Ocean County, NJ · <a href="mailto:contact@apexdetailingoc.com">contact@apexdetailingoc.com</a> · <a href="tel:+17322067084">(732) 206-7084</a></footer>
</div></body></html>
'''

def toc(body):
    hs = re.findall(r'<h2 id="([^"]+)">([^<]+)</h2>', body)
    return '<ul class="toc">' + ''.join(f'<li><a href="#{a}">{t}</a></li>' for a, t in hs) + '</ul>'

terms = '''
<h2 id="agreement">1. Agreement</h2>
<p>These Terms are an agreement between you and Apex Detailing LLC, a New Jersey limited liability company ("Apex", "we", "us"). When you book a detail, sign up for Apex Membership, create an account, or check "I agree" on our site, you agree to these Terms, our <a href="/membership-terms">Membership Terms</a> (if you're a member) and our <a href="/privacy">Privacy Policy</a>. If you don't agree, please don't book.</p>
<p>You must be at least 18 and the owner of the vehicle, or have the owner's permission, to book.</p>

<h2 id="booking">2. Booking and scheduling</h2>
<ul>
<li>When you book online and get a confirmation with a booking code, your time is reserved.</li>
<li>We're mobile. You confirm you have permission for us to work at the address you give us (for example, your driveway, or your landlord or HOA allows it).</li>
<li><b>Water and power.</b> Exterior and Full Details need an outdoor water spigot and an outlet we can reach (an indoor outlet is fine if we can run a cord outside). Interior details need an outlet. If we arrive and can't get water, power or access to the vehicle, we may have to reschedule.</li>
<li>Job lengths are estimates. Heavily soiled vehicles can take longer.</li>
<li>We may reschedule for weather, unsafe conditions, illness or emergencies. If we do, we'll contact you as soon as we can and help you pick a new time at no cost.</li>
</ul>

<h2 id="changes">3. Changes, cancellations and no-shows</h2>
<ul>
<li>You can reschedule or cancel for free up to <b>24 hours</b> before your start time using the link in your confirmation email or your account.</li>
<li>Within 24 hours, please text or call us at (732) 206-7084.</li>
<li>If we arrive at the scheduled time and can't do the job (no one there to unlock the vehicle, no water or power we were told would be available, or the vehicle isn't there), we may require a card on file or a deposit for future bookings.</li>
<li>Apex Membership visits follow the skip and credit rules in our <a href="/membership-terms">Membership Terms</a>.</li>
</ul>

<h2 id="prices">4. Prices and estimates</h2>
<ul>
<li>Prices on our site are starting prices for a vehicle in normal condition, by vehicle size (Sedan, SUV, Truck / 3-row).</li>
<li>Launch pricing applies to a customer's first detail only. Later details are billed at regular prices.</li>
<li>A travel fee applies outside our usual service area and is shown before you book.</li>
<li><b>Sales tax.</b> Our prices don't include New Jersey sales tax (currently 6.625%). We add it to your bill and show it on its own line on your estimate and receipt. Tips aren't taxed.</li>
<li><b>Final price.</b> If your vehicle needs more than the package covers (for example heavy pet hair, heavy stains or odors, or extreme dirt), we'll tell you the final price <b>before we start</b>. You can approve it, choose a different package, or cancel at no charge. We never add charges after the work is done that you didn't approve.</li>
<li>Prices can change. Changes don't affect a booking that's already confirmed.</li>
</ul>

<h2 id="payment">5. Payment</h2>
<ul>
<li>Payment is due when the detail is done. You can pay by card on file, by card in person, by cash, or with a payment link we send you.</li>
<li><b>Card on file.</b> If you choose card on file, you authorize Apex Detailing LLC to charge that card for the final price you approved, plus any travel fee and New Jersey sales tax, after the detail is done, and any tip you choose to add. Cards are stored securely by our payment processor, Square. We never see or store your full card number.</li>
<li>If a payment fails, we'll ask you for another payment method. Unpaid balances are a debt you owe us. If an invoice stays unpaid after reasonable reminders, we may use a collection service or small claims court, and you agree to pay reasonable costs of collecting it where the law allows.</li>
<li>Tips are never required.</li>
</ul>

<h2 id="vehicle">6. Your vehicle</h2>
<ul>
<li><b>Please remove valuables and personal items</b> before we start. We're not responsible for items left in the vehicle, and we may need to move items to clean.</li>
<li><b>Walk-around and photos.</b> Before we start, we look over the vehicle and may take photos to record its condition. Tell us about any damage, loose parts, or areas you're worried about.</li>
<li>We're not responsible for pre-existing damage or conditions, including: chips, scratches, swirls and dents; failing or thin paint or clear coat; loose, brittle or damaged trim, emblems or moldings; aftermarket parts, wraps, tint, film, and coatings; worn, torn or sun-damaged interiors; and electrical or mechanical issues.</li>
<li>Some stains, odors and scratches can't be fully removed. We'll always do our best and tell you what to expect.</li>
<li>Engine bay cleaning carries a small risk on older or already-faulty electrical parts. We use care and avoid sensitive components, but we're not responsible for pre-existing faults.</li>
</ul>

<h2 id="satisfaction">7. If something isn't right</h2>
<p>We do a final walk-around with you. If something isn't right, tell us then, or within <b>48 hours</b> by email or text with photos, and we'll come back and fix the areas the package covers at no charge. This is our first remedy for quality concerns.</p>

<h2 id="damage">8. Damage claims and our liability</h2>
<ul>
<li>If you believe we damaged your vehicle or property, contact us within <b>48 hours</b> of the detail with photos so we can look at it in person.</li>
<li>If we caused the damage through our negligence, we'll repair it or pay the reasonable cost to repair it.</li>
<li>To the fullest extent the law allows, we are not liable for indirect or consequential losses (such as rental cars, lost time or lost income), and our total liability for any claim is limited to the cost to repair the damage we caused. Nothing in these Terms limits liability that can't be limited under New Jersey law.</li>
</ul>

<h2 id="disputes">9. Questions about a charge</h2>
<p>If you have a question or problem with a charge, please contact us first at contact@apexdetailingoc.com or (732) 206-7084. We'll respond quickly and make it right if we made a mistake, usually faster than a bank dispute. If you dispute a charge with your bank, we'll share our records with your bank, including your booking, your agreement to these Terms, emails we sent you, job times, photos and receipts.</p>

<h2 id="photos">10. Photos</h2>
<p>We may take before and after photos for our records and to protect both of us. We only use photos of your vehicle in our marketing (website, Instagram, TikTok) with your permission, and we hide license plates and anything that shows your address.</p>

<h2 id="accounts">11. Your account</h2>
<p>You sign in with a one-time code sent to your email (or phone). Keep access to your email and phone secure. You're responsible for bookings made through your account. Tell us right away if you think someone else has accessed it.</p>

<h2 id="texts">12. Text messages</h2>
<p>If you opt in, we'll text you about your bookings: confirmations, reminders, updates and sign-in codes. Message frequency varies. Message and data rates may apply. Reply <b>STOP</b> to opt out at any time, or <b>HELP</b> for help. Opting in is not required to book. Carriers are not liable for delayed or undelivered messages. See our <a href="/privacy">Privacy Policy</a> for how we handle your number.</p>

<h2 id="general">13. General</h2>
<ul>
<li>We may update these Terms. The version you agreed to applies to bookings you already made; the updated version applies to new bookings. We'll show the date at the top.</li>
<li>These Terms are governed by the laws of the State of New Jersey. Disputes will be handled in the courts of Ocean County, New Jersey, including small claims where it applies.</li>
<li>If part of these Terms can't be enforced, the rest still applies.</li>
<li>Contact: Apex Detailing LLC, Brick, NJ · contact@apexdetailingoc.com · (732) 206-7084.</li>
</ul>
'''

mem = '''
<h2 id="plans">1. Plans</h2>
<ul>
<li>Apex Membership gives you regular visits at a lower price per visit. You choose what each visit covers (<b>Wash</b>, <b>Interior</b>, or <b>Wash + interior</b>), how often (monthly, every 2 weeks, or weekly), and your vehicle size. Your plan and monthly price are shown before you sign up and in your account.</li>
<li>Members also get 10% off add-ons and priority on weekend times.</li>
<li>Our general <a href="/terms">Terms of Service</a> also apply to memberships.</li>
</ul>

<h2 id="starting">2. Starting a membership</h2>
<ul>
<li>A membership starts after a qualifying detail, so every visit starts from a clean slate: Wash plans after an Exterior or Full Detail; Interior plans after an Interior or Full Detail; Wash + interior after a Full Detail.</li>
<li>You must sign up within <b>14 days</b> of your qualifying detail.</li>
<li><b>A card on file is required</b> for memberships. You can pay for your qualifying detail any way you like; if you paid in person, you have 14 days to add a card in your account.</li>
</ul>

<h2 id="billing">3. Billing</h2>
<div class="box"><p><b>Recurring charge authorization.</b> When you sign up, you authorize Apex Detailing LLC to charge your card on file the monthly price shown plus New Jersey sales tax (currently 6.625%), starting <b>one month after your qualifying detail</b> and on that same date every month, until your membership ends as described below. Your bank statement will show Apex Detailing. We'll email you a receipt for each charge.</p></div>
<ul>
<li>If the date doesn't exist in a month (like the 31st), we bill on the last day of that month.</li>
<li>We may change membership prices with at least <b>30 days' notice</b> by email. You can cancel before the new price applies, subject to the minimum term below.</li>
<li><b>Failed payments.</b> If a charge fails, we'll retry it and email you. Visits are paused until the balance is paid. If it stays unpaid, we may end the membership; amounts already owed are still due.</li>
<li>You can't remove your card while your membership is active, but you can replace it with another card anytime in your account.</li>
</ul>

<h2 id="visits">4. Scheduling visits</h2>
<ul>
<li>You pick your visit times in your account from our open times.</li>
<li>Each monthly payment covers the month that starts on that charge date. Your first visits can be booked once your first monthly payment goes through, one month after your qualifying detail.</li>
<li>Visits are for the vehicle on your plan. Visits don't roll over to later months, except for credits described below.</li>
</ul>

<h2 id="skips">5. Skips, missed visits and credits</h2>
<ul>
<li><b>If we cancel</b> a visit (our scheduling, illness, or weather), you get a full credit, or a refund if you prefer.</li>
<li><b>If you skip</b> with at least <b>48 hours'</b> notice, you get a <b>50% credit</b> for that visit.</li>
<li>If you skip with less than 48 hours' notice, or we arrive and can't do the visit (no access, no water or power we were told would be available), no credit is given.</li>
<li>A skipped visit counts as used for that month, so it can't be rebooked. The credit takes its place.</li>
<li>Credits are applied to your next monthly charge.</li>
</ul>

<h2 id="winter">6. Winter (December 15 – March 1)</h2>
<ul>
<li>We only do interior work from December 15 to March 1.</li>
<li><b>Wash plans pause</b> during this time and aren't billed.</li>
<li><b>Wash + interior</b> members get interior visits during this time and are billed at the Interior plan price.</li>
<li>Interior plans continue as normal.</li>
<li>Paused time doesn't count toward the 3-month minimum.</li>
</ul>

<h2 id="minimum">7. 3-month minimum and cancelling</h2>
<p>Every membership has a <b>3-month minimum</b>: three monthly payments.</p>
<h3>Cancelling during the first 3 months</h3>
<p>You can request to cancel anytime in your account. You choose one of these:</p>
<ul>
<li>Before your first monthly charge, you can cancel for free.</li>
<li><b>Finish your 3 months:</b> you keep your visits, the remaining monthly payments in your first 3 months are charged as usual, and your membership ends automatically after your third payment. No fee.</li>
<li><b>Cancel now:</b> no more monthly charges, and you pay a one-time cancellation fee equal to <b>50% of the monthly payments left</b> in your 3-month minimum, plus New Jersey sales tax. You can still use visits you've already paid for until the end of that month. For example, if you cancel after your first payment, two payments are left, so the fee is one month's price.</li>
</ul>
<h3>After 3 months</h3>
<ul>
<li>Cancel anytime in your account, no fee. Cancelling stops future charges; your membership stays active through the period you've already paid for.</li>
<li>You can also pause for up to 3 months and keep your current price. The pause starts after the month you've already paid for, so you keep those visits.</li>
</ul>
<p>Questions about your membership: contact@apexdetailingoc.com or (732) 206-7084.</p>
'''

privacy = '''
<h2 id="collect">1. What we collect</h2>
<ul>
<li><b>Contact details:</b> name, email, phone number.</li>
<li><b>Service details:</b> the address where we detail, your vehicle (year, make, model, color, size), the package and add-ons you choose, notes you give us (like gate codes or where the spigot is), and your booking history.</li>
<li><b>Photos:</b> before and after photos we take of your vehicle, and photos you choose to send us.</li>
<li><b>Payment details:</b> payments are handled by Square. We store only the card brand and last 4 digits, plus payment records (amounts, dates, receipts). We never see or store your full card number.</li>
<li><b>Agreement records:</b> when you agree to our Terms or authorize membership charges, we record the date, time, version, and your IP address.</li>
<li><b>Sign-in:</b> one-time sign-in codes (stored scrambled) and a cookie that keeps you signed in. We don't use advertising trackers or sell ads.</li>
</ul>

<h2 id="use">2. How we use it</h2>
<ul>
<li>To schedule, perform and get paid for your details and membership.</li>
<li>To send booking emails and, if you opt in, text messages: confirmations, reminders, updates and sign-in codes.</li>
<li>To keep records for quality, safety, taxes, and resolving disputes or chargebacks.</li>
<li>To show before and after photos in our marketing, only with your permission and with plates and addresses hidden.</li>
</ul>

<h2 id="share">3. Who we share it with</h2>
<p>We don't sell your personal information. We share it only with service providers that help us run Apex Detailing, and only what they need:</p>
<ul>
<li><b>Square</b> (payments), <b>Cloudflare</b> (website hosting and our database), <b>Resend</b> (email delivery), <b>Twilio</b> (text messages and sign-in codes), and <b>Apple iCloud</b> (our private job calendar).</li>
<li>Your bank or card issuer, if you dispute a charge.</li>
<li>When the law requires it, or to protect our rights in a legal dispute.</li>
</ul>
<div class="box"><p><b>Text messaging.</b> No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent will not be shared with any third parties. Your number is used only to send the messages you signed up for. Reply STOP to opt out at any time.</p></div>

<h2 id="keep">4. How long we keep it</h2>
<p>We keep booking, payment and agreement records for as long as needed for taxes and legal purposes (generally up to 7 years). You can ask us to delete your account and personal information sooner; we'll delete what we aren't required to keep.</p>

<h2 id="choices">5. Your choices</h2>
<ul>
<li>Update your details anytime in your account.</li>
<li>Turn off reminder emails in your account. Reply STOP to stop texts.</li>
<li>Ask us for a copy of your information, to correct it, or to delete it: contact@apexdetailingoc.com.</li>
</ul>

<h2 id="security">6. Security</h2>
<p>We use secure, encrypted connections, store card details only with Square, and limit access to your information. No system is perfectly secure, so please tell us right away if you notice anything unusual.</p>

<h2 id="kids">7. Children</h2>
<p>Our services are for adults. We don't knowingly collect information from children under 13.</p>

<h2 id="changes">8. Changes and contact</h2>
<p>If we change this policy, we'll update the date at the top. Questions: Apex Detailing LLC, Brick, NJ · contact@apexdetailingoc.com · (732) 206-7084.</p>
'''

out = os.path.join(root, '..', 'apex-site', 'public')
docs = [("terms", "Terms of Service", '<p class="lede">The short version: we\'ll show up when we say, tell you the price before we start, take care of your car, and make it right if something isn\'t. Here are the details.</p>', terms),
        ("membership-terms", "Membership Terms", '<p class="lede">How Apex Membership billing, visits, skips, winter and cancelling work.</p>', mem),
        ("privacy", "Privacy Policy", '<p class="lede">What we collect, why, and who we share it with. We don\'t sell your information.</p>', privacy)]
for slug, title, intro, body in docs:
    open(os.path.join(out, slug + '.html'), 'w').write(page(slug, title, intro + toc(body), body))
open(os.path.join(root, 'VERSION'), 'w').write(VERSION)
print("ok")
