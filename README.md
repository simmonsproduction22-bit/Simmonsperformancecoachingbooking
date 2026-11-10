# Coach Booking

A booking and payments site for private coaches. Clients buy lesson packages, then book, reschedule and cancel lessons online. Package money is **held by Stripe and released to the coach one lesson at a time** as lessons are marked done.

Built for one coach first, with multiple coaches supported from day one: each coach gets their own page at `/<their-name>`, their own clients and their own payouts.

## Launch checklist (Simmons Performance Coaching)

Live at **https://simmonsperformancecoaching.netlify.app** (Netlify project `simmonsperformancecoaching`, deploys on every push to `main`).

1. **Deploy on Netlify** from this repo. The build command (`node scripts/stamp-site-url.mjs`) fills in the site address for link previews, search info and the sitemap. Netlify Database is set up and every migration runs on deploy.
2. **Create your coach account first** at `/admin`, using page address `simmons`. The very first account is filled in automatically from `src/defaults.ts`: name, headline, bio, credentials, Dallas location and training spots, contact email and phone, Zelle and Cash App, 12-hour cancel window, weekly hours (Mon–Fri 3–8 PM, Sat 9 AM–2 PM) and the packages (12-pack, 8-pack, single, $60 intro lesson for new clients, small groups). Change anything in Settings.
3. **Turn on email**, the same setup as the Fortis MMA site (Netlify Forms):
   - In Netlify, open **Forms** and enable form detection, then redeploy once so the forms are picked up.
   - Under **Forms → Form notifications → Add notification → Email**, send to `SimmonsMMA26@gmail.com`. Add one for each form (or "Any form"):
     - `contact`: "Send a message" on the page
     - `payment-submitted`: someone paid by Zelle or Cash App and is waiting for approval (includes a link to review it)
     - `quote-request`: corporate training quote requests
     - `lesson-booked`: a client booked a lesson (time, place and any in-home address)
4. **Domain:** add your domain under Domain management and redeploy, so link previews use it.
5. **Card payments (Stripe):** card checkout shows on the page once Netlify has your Stripe key. Clients pay on Stripe's checkout, are sent back to the site, and their lessons unlock right away. No screenshot and nothing to approve. The payment shows in the dashboard under Money and Clients as "card (Stripe)", and you get the `payment-submitted` email marked "already paid". Prices are charged exactly as listed, with no sales tax added. The page says "Sales tax not included".
   - In Stripe: **Developers → API keys → Create restricted key** with **Checkout Sessions: Write** and **Payment Intents: Write** (Write is needed for refunds from the dashboard). Leave everything else as None.
   - In Netlify: **Site configuration → Environment variables**, add `STRIPE_SECRET_KEY` = that key (`rk_live_...`), then redeploy.
   - Recommended, so a payment still counts if the client closes the tab before coming back: in Stripe, go to **Developers → Webhooks → Add endpoint** `https://simmonsperformancecoaching.netlify.app/api/stripe/webhook` with events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`. Then add its signing secret in Netlify as `STRIPE_WEBHOOK_SECRET` (`whsec_...`).
   - Card money goes straight to your own Stripe balance and pays out on your normal Stripe schedule. Stripe Connect and holding funds aren't used for this.

### Pages
- `/<slug>`: the coach page. `/<slug>/privacy` and `/<slug>/terms`: privacy policy and terms (drafts written from how the site works; review them).
- `/admin`: the coach dashboard.

### Spam protection on Zelle / Cash App payments
- A hidden honeypot field stops simple bots.
- Each sender (by IP) can submit 5 payments a day; at most 60 can wait for review at once.
- Screenshots are shrunk in the browser and capped at 2 MB on the server.

## Paying by Zelle or Cash App (default)

No account is needed to buy. On any package the client:
1. Sees the amount and your Zelle email/phone or Cash App $cashtag (with a copy button and an "Open Cash App" link).
2. Enters their name and email (phone optional).
3. Uploads a screenshot of the payment. It's shrunk in the browser to 1600px before upload.

An account is created from their email automatically and they're signed in on that device, with an optional step to set a password. If the email already has an account, the purchase is added to it and they sign in as usual.

You review each one under **Money → Payments to approve** (the Money tab shows a count). Each entry has the screenshot, amount and package, with **Approve** and **Reject** buttons. Approving unlocks the lessons right away. Rejecting shows your reason on their page. Set your Zelle and Cash App details in **Settings → Getting paid**.

These payments go straight to you, so nothing is held; delivered lessons are tracked under "Lessons delivered."

## How the money works (card payments, optional)

```
Client buys "4 lessons for $240" by card
        │
        ▼
$240 lands in the PLATFORM Stripe balance (payouts set to manual, so it stays there)
        │
        │  Coach marks lesson 1 Done / No-show / Late cancel
        ▼
$60 transfers to the COACH's connected Stripe account → their bank (daily)
```

- Each lesson releases `price ÷ lessons`. The last lesson picks up any rounding, so the total always matches exactly.
- **Canceled in time**: the lesson goes back on the client's balance and nothing is released.
- **Refund**: refunds whatever is still held and cancels that package's upcoming lessons. Lessons already done stay paid.
- **Expired package**: the coach chooses **Keep** (release the rest) or **Refund**.
- **Paid in person** (cash, Zelle, Venmo): the coach adds the package by hand. The client gets the lessons and nothing is held.
- A Stripe outage never blocks marking a lesson. Releases queue up and send on the next try, and each transfer is idempotent, so nothing pays twice.

Stripe fees: about 2.9% + 30¢ per card payment (about $7.26 on $240). Transfers and payouts to the coach are free on standard Connect pricing; check your Stripe pricing page.

## Pages

| URL | Who | What |
|---|---|---|
| `/<slug>` | Clients | Coach bio, packages, policies; sign up, buy, book, reschedule, cancel |
| `/admin` | Coach | Schedule, close-out queue, clients, money, packages, weekly hours, time off, settings |
| `/` | Anyone | Redirects to the coach when there's only one; otherwise a list of coaches |

## Packages, groups and corporate

- **Private packages**: one price for N lessons. The **Packages** tab has a one-tap starter set: Single $125, 8-Pack $880 ($110 each), 12-Pack $1,200 ($100 each).
- **Small groups** (type "Small group"): the price is **per person** with a min/max headcount (starter: $50/person, 3–10 people). One client picks the headcount and pays for everyone, e.g. 4 people = $200. The booked lesson shows as "Group of 4", and closing it out releases the full $200.
- **Premium corporate training**: a "Request a quote" form on the coach page sends requests to the **Requests** tab. **Create offer** makes a private package with a custom price and a link only that company can open (it's never listed publicly). They sign up through the link and pay by card like any other package, and it releases per session.
- Clients with more than one kind of lesson left (say a private lesson and a group of 3) pick which one when booking.

## Booking rules (set per coach in Settings)

Lesson length, start-time spacing, break between lessons, minimum notice, how far ahead clients can book, and the free cancel/reschedule window (default 24h). Inside the window, clients see "contact your coach" instead of the buttons, and the coach can mark it a **Late cancel**, which counts as used and releases the money.

## Setup

### 1. Deploy on Netlify
Create a **new Netlify site** from this repo (no base directory needed). Netlify Database is provisioned automatically, and migrations in `netlify/database/migrations` run on deploy.

### 2. Stripe
1. Create a Stripe account for the business and turn on **Connect** (Dashboard → Connect → Get started, choose "Platform").
2. **Set the platform's payout schedule to Manual** (Settings → Payouts). This is what keeps client money held. Without it, Stripe sweeps the balance to your bank and the hold does nothing.
3. Add a webhook endpoint `https://<your-site>/api/stripe/webhook` with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `account.updated`.
   Enable "Listen to events on Connected accounts" as well, for `account.updated`.
4. In Netlify → Site configuration → Environment variables, add:
   - `STRIPE_SECRET_KEY`: `sk_test_...` while testing, `sk_live_...` when live
   - `STRIPE_WEBHOOK_SECRET`: `whsec_...` from the webhook you created
5. Redeploy.

### 3. Create your coach account
Go to `/admin` → **Create an account**. The first account needs no invite code. Then:
1. **Settings**: bio, headline, booking rules.
2. **Packages**: add packages. Keep use-by at **90 days or less**, because Stripe limits how long funds can be held before transfer.
3. **Availability**: weekly hours.
4. **Money** → **Connect payouts**: Stripe collects your business checking and ID. Released lessons wait until this is done, then send automatically.

### Adding more coaches later
Set `COACH_SIGNUP_CODE` in Netlify env vars and share it. Each coach signs up at `/admin`, gets their own page and connects their own bank. To take a cut, set `platform_fee_bps` on their row (for example `500` = 5% of each released lesson; it stays in the platform balance).

## Local development

```bash
npm install
# any Postgres with the migration applied:
psql "$DB" -f netlify/database/migrations/20261105000000_init.sql
COACH_DB_URL="$DB" PAYMENTS_MODE=fake node scripts/dev-server.mjs   # http://localhost:8888
COACH_DB_URL="$DB" PAYMENTS_MODE=fake npm test                      # wipes the database's tables
```

`PAYMENTS_MODE=fake` simulates Stripe (checkout succeeds instantly and transfers are pretend). Never set it on the live site.

## Not built yet
- Email/text reminders and booking notifications
- Self-serve "forgot password" (for now the coach resets it from the client's page in the dashboard)
- Google Calendar sync
- Undoing a lesson that has already paid out (do it in the Stripe dashboard with a transfer reversal)

## Photo credits

`public/corporate.jpg` is the main training floor at Fortis MMA, taken from the Fortis MMA website (`img/hero-bg.jpg`). The other photos are the coach's own.
