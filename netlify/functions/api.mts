// Coach platform API: one function, routed by path.
//   /api/c/:slug/...      public coach page + client accounts (buy, book, reschedule, cancel)
//   /api/coach/...        coach dashboard
//   /api/stripe/webhook   Stripe events
import type { Config } from "@netlify/functions";
import { q, tx, type Q } from "../../src/db.ts";
import {
  createSession, endSession, hashPassword, normEmail, sessionUser, validEmail, verifyLogin,
} from "../../src/auth.ts";
import {
  RELEASES, UserError, confirmPurchase, openCredits, recordForfeit, recordLessonRelease, sendPendingReleases,
} from "../../src/money.ts";
import { payments, paymentsConfigured } from "../../src/payments.ts";
import { localDate, openSlots, validTimeZone, type Busy } from "../../src/time.ts";
import { randomBytes } from "node:crypto";

// ---------- helpers ----------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (status: number, message: string) => json({ error: message }, status);

async function body(req: Request): Promise<Record<string, any>> {
  try { const b = await req.json(); return b && typeof b === "object" ? b : {}; } catch { return {}; }
}
const str = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);
const int = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
const origin = (req: Request) => process.env.URL && !process.env.NETLIFY_DEV ? process.env.URL : new URL(req.url).origin;

const RESERVED = new Set(["api", "admin", "coach", "login", "signup", "assets", "static", "app", "www", "help", "about"]);
const validSlug = (s: string) => /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(s) && !RESERVED.has(s);

const COACH_PUBLIC = `id, slug, name, headline, bio, location, timezone, lesson_minutes, cancel_window_hours,
  min_notice_hours, max_days_ahead`;

function publicCoach(c: any) {
  return {
    slug: c.slug, name: c.name, headline: c.headline, bio: c.bio, location: c.location, timezone: c.timezone,
    lessonMinutes: c.lesson_minutes, cancelWindowHours: c.cancel_window_hours,
    minNoticeHours: c.min_notice_hours, maxDaysAhead: c.max_days_ahead,
  };
}
function pkgOut(p: any, forCoach = false) {
  return {
    id: p.id, name: p.name, description: p.description, lessonCount: p.lesson_count, priceCents: p.price_cents,
    expiresDays: p.expires_days, active: p.active, sortOrder: p.sort_order,
    kind: p.kind, minPeople: p.min_people, maxPeople: p.max_people, isOffer: Boolean(p.offer_token),
    ...(forCoach ? { offerToken: p.offer_token, offerFor: p.offer_for } : {}),
  };
}

/** What a client pays for a package: group prices are per person. */
function packageTotal(pkg: any, people: number) {
  return pkg.kind === "group" ? pkg.price_cents * people : pkg.price_cents;
}
function partySize(pkg: any, requested: unknown): number {
  if (pkg.kind !== "group") return 1;
  const n = int(requested);
  if (!(n >= pkg.min_people && n <= pkg.max_people)) {
    throw new UserError(`Group lessons are for ${pkg.min_people} to ${pkg.max_people} people.`);
  }
  return n;
}
function lessonOut(l: any) {
  return {
    id: l.id, startsAt: l.starts_at, endsAt: l.ends_at, status: l.status, note: l.client_note,
    purchaseId: l.purchase_id, clientId: l.client_id, clientName: l.client_name,
    releaseStatus: l.release_status ?? null,
    kind: l.package_kind ?? "private", partySize: l.party_size ?? 1,
  };
}
const LESSON_COLS = `l.*, p.package_kind, p.party_size`;
function purchaseOut(p: any) {
  return {
    id: p.id, clientId: p.client_id, clientName: p.client_name, packageName: p.package_name,
    lessonsTotal: p.lessons_total, lessonsUsed: p.lessons_used ?? null, amountCents: p.amount_cents,
    method: p.method, status: p.status, releasedCents: p.released_cents, refundedCents: p.refunded_cents,
    kind: p.package_kind, partySize: p.party_size,
    heldCents: p.method === "card" && p.status === "paid" ? p.amount_cents - p.released_cents - p.refunded_cents : 0,
    paidAt: p.paid_at, expiresAt: p.expires_at, createdAt: p.created_at,
  };
}

async function coachBySlug(slug: string) {
  const [c] = await q(`SELECT * FROM coaches WHERE slug = $1`, [slug]);
  return c ?? null;
}

/** Busy time for a coach between two instants: booked lessons (padded by buffer) and time off. */
async function busyFor(t: Q, coach: any, from: number, to: number, excludeLessonId = 0): Promise<Busy[]> {
  const pad = coach.buffer_minutes * 60_000;
  const lessons = await t(
    `SELECT starts_at, ends_at FROM lessons WHERE coach_id = $1 AND status = 'booked' AND id <> $4
       AND ends_at > $2 AND starts_at < $3`,
    [coach.id, new Date(from - 86_400_000), new Date(to + 86_400_000), excludeLessonId]);
  const off = await t(
    `SELECT starts_at, ends_at FROM time_off WHERE coach_id = $1 AND ends_at > $2 AND starts_at < $3`,
    [coach.id, new Date(from - 86_400_000), new Date(to + 86_400_000)]);
  return [
    ...lessons.map((l) => ({ start: +new Date(l.starts_at) - pad, end: +new Date(l.ends_at) + pad })),
    ...off.map((o) => ({ start: +new Date(o.starts_at), end: +new Date(o.ends_at) })),
  ];
}

async function slotsFor(t: Q, coach: any, fromDate: string, days: number, excludeLessonId = 0) {
  const windows = await t(`SELECT weekday, start_min, end_min FROM availability WHERE coach_id = $1`, [coach.id]);
  const from = Date.parse(fromDate + "T00:00:00Z") - 86_400_000;
  const busy = await busyFor(t, coach, from, from + (days + 2) * 86_400_000, excludeLessonId);
  return openSlots(coach, windows, busy, fromDate, days);
}

/** Checks a requested start time against the coach's rules; throws if it isn't bookable. */
async function assertBookable(t: Q, coach: any, start: number, excludeLessonId: number, asCoach: boolean) {
  if (!Number.isFinite(start)) throw new UserError("Pick a time.");
  if (asCoach) {
    const end = start + coach.lesson_minutes * 60_000;
    const busy = await busyFor(t, coach, start, end, excludeLessonId);
    if (busy.some((b) => start < b.end && end > b.start)) throw new UserError("That time overlaps another lesson or time off.");
    return;
  }
  const open = await slotsFor(t, coach, localDate(start, coach.timezone), 1, excludeLessonId);
  if (!open.includes(start)) throw new UserError("That time was just taken or isn't available. Pick another.", 409);
}

async function bookLesson(coach: any, clientId: number, start: number, note: string, asCoach: boolean, purchaseId = 0) {
  return tx(async (t) => {
    await t(`SELECT pg_advisory_xact_lock($1)`, [coach.id]);        // one booking at a time per coach
    await assertBookable(t, coach, start, 0, asCoach);
    const credits = (await openCredits(t, clientId)).filter((c) => !purchaseId || c.id === purchaseId);
    const credit = credits.find((c) => !c.expires_at || +new Date(c.expires_at) > start);
    if (!credit) {
      throw new UserError(credits.length
        ? "Your remaining lessons expire before that date. Pick an earlier time."
        : "No lessons left. Buy a package to book.", 402);
    }
    const [l] = await t(
      `INSERT INTO lessons (coach_id, client_id, purchase_id, starts_at, ends_at, client_note)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [coach.id, clientId, credit.id, new Date(start), new Date(start + coach.lesson_minutes * 60_000), note]);
    return { ...l, package_kind: credit.package_kind, party_size: credit.party_size };
  });
}

const hoursUntil = (d: any) => (+new Date(d) - Date.now()) / 3_600_000;

// ---------- public + client routes ----------

async function clientRoutes(req: Request, slug: string, parts: string[]): Promise<Response> {
  const coach = await coachBySlug(slug);
  if (!coach) return fail(404, "Coach not found.");
  const [a, b, c] = parts;
  const m = req.method;

  if (m === "GET" && !a) {
    const pkgs = await q(
      `SELECT * FROM packages WHERE coach_id = $1 AND active AND offer_token IS NULL ORDER BY sort_order, price_cents`, [coach.id]);
    const token = new URL(req.url).searchParams.get("offer");
    const [offer] = token
      ? await q(`SELECT * FROM packages WHERE coach_id = $1 AND active AND offer_token = $2`, [coach.id, token.slice(0, 100)])
      : [];
    return json({
      coach: publicCoach(coach), packages: pkgs.map((p) => pkgOut(p)),
      offer: offer ? pkgOut(offer) : null, paymentsReady: paymentsConfigured(),
    });
  }

  if (m === "POST" && a === "inquiries") {
    const d = await body(req);
    if (str(d.website)) return json({ ok: true });            // honeypot: bots fill every field
    const name = str(d.name, 80), email = normEmail(d.email);
    if (!name) return fail(400, "Add your name.");
    if (!validEmail(email)) return fail(400, "Enter a valid email address.");
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM inquiries WHERE coach_id = $1 AND email = $2 AND created_at > NOW() - INTERVAL '1 day'`,
      [coach.id, email]);
    if (n >= 3) return fail(429, "We already have your request. We'll be in touch soon.");
    await q(
      `INSERT INTO inquiries (coach_id, kind, name, email, phone, company, group_size, message)
       VALUES ($1, 'corporate', $2, $3, $4, $5, $6, $7)`,
      [coach.id, name, email, str(d.phone, 30), str(d.company, 120), str(d.groupSize, 60), str(d.message, 3000)]);
    return json({ ok: true }, 201);
  }

  if (m === "GET" && a === "slots") {
    const url = new URL(req.url);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : localDate(Date.now(), coach.timezone);
    const days = Math.min(14, Math.max(1, int(url.searchParams.get("days")) || 7));
    const exclude = int(url.searchParams.get("exclude")) || 0;
    const slots = await slotsFor(q, coach, from, days, exclude);
    return json({ timezone: coach.timezone, slots: slots.map((s) => new Date(s).toISOString()) });
  }

  if (m === "POST" && a === "signup") {
    const d = await body(req);
    const email = normEmail(d.email), name = str(d.name, 80), phone = str(d.phone, 30), pw = String(d.password ?? "");
    if (!name) return fail(400, "Add your name.");
    if (!validEmail(email)) return fail(400, "Enter a valid email address.");
    if (pw.length < 8) return fail(400, "Use at least 8 characters for your password.");
    const [exists] = await q(`SELECT id FROM clients WHERE coach_id = $1 AND email = $2`, [coach.id, email]);
    if (exists) return fail(409, "You already have an account. Sign in instead.");
    const [row] = await q(
      `INSERT INTO clients (coach_id, email, password_hash, name, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [coach.id, email, await hashPassword(pw), name, phone]);
    return json({ token: await createSession("client", row.id) }, 201);
  }

  if (m === "POST" && a === "login") {
    const d = await body(req);
    const [row] = await q(`SELECT * FROM clients WHERE coach_id = $1 AND email = $2`, [coach.id, normEmail(d.email)]);
    const err = await verifyLogin("clients", row, String(d.password ?? ""));
    if (err) return fail(401, err);
    return json({ token: await createSession("client", row.id) });
  }

  // Everything below needs a signed-in client of this coach.
  const clientId = await sessionUser(req, "client");
  const [client] = clientId ? await q(`SELECT * FROM clients WHERE id = $1 AND coach_id = $2`, [clientId, coach.id]) : [];
  if (!client) return fail(401, "Sign in to continue.");

  if (m === "POST" && a === "logout") { await endSession(req); return json({ ok: true }); }

  if (m === "GET" && a === "me") {
    const credits = await openCredits(q, client.id);
    const lessons = await q(
      `SELECT ${LESSON_COLS} FROM lessons l JOIN purchases p ON p.id = l.purchase_id
       WHERE l.client_id = $1 AND (l.status = 'booked' OR l.starts_at > NOW() - INTERVAL '120 days')
       ORDER BY l.starts_at DESC LIMIT 100`, [client.id]);
    const purchases = await q(
      `SELECT p.*, (SELECT COUNT(*)::int FROM lessons l WHERE l.purchase_id = p.id AND l.status <> 'canceled') AS lessons_used
       FROM purchases p WHERE client_id = $1 AND status IN ('paid', 'refunded') ORDER BY created_at DESC`, [client.id]);
    return json({
      client: { name: client.name, email: client.email, phone: client.phone },
      creditsRemaining: credits.reduce((s, c) => s + c.remaining, 0),
      credits: credits.map((c) => ({
        purchaseId: c.id, packageName: c.package_name, remaining: c.remaining, expiresAt: c.expires_at,
        kind: c.package_kind, partySize: c.party_size,
      })),
      lessons: lessons.map(lessonOut),
      purchases: purchases.map((p) => ({ ...purchaseOut(p), heldCents: undefined, releasedCents: undefined })),
    });
  }

  if (m === "POST" && a === "checkout") {
    const d = await body(req);
    const [pkg] = await q(
      `SELECT * FROM packages WHERE id = $1 AND coach_id = $2 AND active AND (offer_token IS NULL OR offer_token = $3)`,
      [int(d.packageId), coach.id, str(d.offer, 100)]);
    if (!pkg) return fail(404, "That package isn't available.");
    if (!paymentsConfigured()) return fail(503, "Online payments aren't turned on yet. Contact your coach.");
    const people = partySize(pkg, d.people);
    const total = packageTotal(pkg, people);
    const [p] = await q(
      `INSERT INTO purchases (coach_id, client_id, package_id, package_name, lessons_total, amount_cents, method, package_kind, party_size)
       VALUES ($1, $2, $3, $4, $5, $6, 'card', $7, $8) RETURNING id`,
      [coach.id, client.id, pkg.id, pkg.name, pkg.lesson_count, total, pkg.kind, people]);
    const base = `${origin(req)}/${coach.slug}`;
    try {
      const s = await payments().createCheckout({
        purchaseId: p.id, coachId: coach.id, amountCents: total,
        name: `${pkg.name} with ${coach.name}`,
        description: `${pkg.lesson_count} lesson${pkg.lesson_count > 1 ? "s" : ""}`
          + (pkg.kind === "group" ? ` · group of ${people} at $${(pkg.price_cents / 100).toFixed(2)} per person` : "")
          + ` · use within ${pkg.expires_days} days`,
        email: client.email,
        successUrl: `${base}?paid=${p.id}`,
        cancelUrl: `${base}?canceled=${p.id}`,
      });
      await q(`UPDATE purchases SET stripe_session_id = $2 WHERE id = $1`, [p.id, s.id]);
      return json({ url: s.url, purchaseId: p.id });
    } catch (e: any) {
      await q(`UPDATE purchases SET status = 'canceled' WHERE id = $1`, [p.id]);
      console.error("checkout failed", e);
      return fail(502, "Couldn't start checkout. Try again in a minute.");
    }
  }

  if (m === "POST" && a === "purchases" && c === "confirm") {
    const [p] = await q(`SELECT id FROM purchases WHERE id = $1 AND client_id = $2`, [int(b), client.id]);
    if (!p) return fail(404, "Purchase not found.");
    return json({ paid: await confirmPurchase(p.id) });
  }

  if (m === "POST" && a === "lessons" && !b) {
    const d = await body(req);
    const l = await bookLesson(coach, client.id, Date.parse(String(d.startsAt)), str(d.note, 500), false, int(d.purchaseId) || 0);
    return json({ lesson: lessonOut(l) }, 201);
  }

  if (m === "POST" && a === "lessons" && (c === "reschedule" || c === "cancel")) {
    const d = await body(req);
    const lessonId = int(b);
    const result = await tx(async (t) => {
      await t(`SELECT pg_advisory_xact_lock($1)`, [coach.id]);
      const [l] = await t(`SELECT * FROM lessons WHERE id = $1 AND client_id = $2 FOR UPDATE`, [lessonId, client.id]);
      if (!l || l.status !== "booked") throw new UserError("That lesson can't be changed.", 404);
      if (hoursUntil(l.starts_at) < coach.cancel_window_hours) {
        throw new UserError(`Lessons can only be changed online up to ${coach.cancel_window_hours} hours ahead. Contact ${coach.name} directly.`, 403);
      }
      if (c === "cancel") {
        const [u] = await t(`UPDATE lessons SET status = 'canceled', closed_at = NOW() WHERE id = $1 RETURNING *`, [l.id]);
        return u;
      }
      const start = Date.parse(String(d.startsAt));
      await assertBookable(t, coach, start, l.id, false);
      const [p] = await t(`SELECT expires_at FROM purchases WHERE id = $1`, [l.purchase_id]);
      if (p.expires_at && +new Date(p.expires_at) <= start) throw new UserError("This lesson's package expires before that date.");
      const [u] = await t(`UPDATE lessons SET starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING *`,
        [l.id, new Date(start), new Date(start + coach.lesson_minutes * 60_000)]);
      return u;
    });
    return json({ lesson: lessonOut(result) });
  }

  return fail(404, "Not found.");
}

// ---------- coach routes ----------

async function coachDashboard(coach: any) {
  const id = coach.id;
  const [money] = await q(
    `SELECT
       COALESCE((SELECT SUM(amount_cents - released_cents - refunded_cents) FROM purchases
                 WHERE coach_id = $1 AND method = 'card' AND status = 'paid'), 0)::int AS held,
       COALESCE((SELECT SUM(amount_cents - fee_cents) FROM releases WHERE coach_id = $1 AND status IN ('pending', 'failed')), 0)::int AS releasing,
       COALESCE((SELECT SUM(amount_cents - fee_cents) FROM releases WHERE coach_id = $1 AND status = 'sent'
                 AND sent_at >= date_trunc('month', NOW() AT TIME ZONE $2) AT TIME ZONE $2), 0)::int AS sent_month,
       COALESCE((SELECT SUM(amount_cents - fee_cents) FROM releases WHERE coach_id = $1 AND status = 'sent'), 0)::int AS sent_total,
       COALESCE((SELECT SUM(amount_cents) FROM releases WHERE coach_id = $1 AND status = 'not_held'
                 AND created_at >= date_trunc('month', NOW() AT TIME ZONE $2) AT TIME ZONE $2), 0)::int AS offline_month`,
    [id, coach.timezone]);
  const lessons = await q(
    `SELECT ${LESSON_COLS}, c.name AS client_name, r.status AS release_status FROM lessons l
     JOIN clients c ON c.id = l.client_id JOIN purchases p ON p.id = l.purchase_id
     LEFT JOIN releases r ON r.lesson_id = l.id
     WHERE l.coach_id = $1 AND (l.status = 'booked' OR l.starts_at > NOW() - INTERVAL '30 days')
     ORDER BY l.starts_at`, [id]);
  const clients = await q(
    `SELECT c.id, c.name, c.email, c.phone, c.notes, c.created_at,
       COALESCE((SELECT SUM(p.lessons_total - (SELECT COUNT(*) FROM lessons l WHERE l.purchase_id = p.id
                   AND l.status IN ('booked', 'completed', 'no_show', 'late_cancel')))
                 FROM purchases p WHERE p.client_id = c.id AND p.status = 'paid'
                   AND (p.expires_at IS NULL OR p.expires_at > NOW())), 0)::int AS credits,
       (SELECT MIN(starts_at) FROM lessons l WHERE l.client_id = c.id AND l.status = 'booked' AND l.starts_at > NOW()) AS next_lesson
     FROM clients c WHERE c.coach_id = $1 ORDER BY c.name`, [id]);
  const purchases = await q(
    `SELECT p.*, c.name AS client_name,
       (SELECT COUNT(*)::int FROM lessons l WHERE l.purchase_id = p.id
          AND l.status IN ('booked', 'completed', 'no_show', 'late_cancel')) AS lessons_used
     FROM purchases p JOIN clients c ON c.id = p.client_id
     WHERE p.coach_id = $1 AND p.status IN ('paid', 'refunded') ORDER BY p.created_at DESC LIMIT 200`, [id]);
  const releases = await q(
    `SELECT r.*, c.name AS client_name, p.package_name, l.starts_at AS lesson_at FROM releases r
     JOIN purchases p ON p.id = r.purchase_id JOIN clients c ON c.id = p.client_id
     LEFT JOIN lessons l ON l.id = r.lesson_id
     WHERE r.coach_id = $1 ORDER BY r.created_at DESC LIMIT 100`, [id]);
  const packages = await q(`SELECT * FROM packages WHERE coach_id = $1 ORDER BY active DESC, sort_order, price_cents`, [id]);
  const availability = await q(`SELECT weekday, start_min, end_min FROM availability WHERE coach_id = $1 ORDER BY weekday, start_min`, [id]);
  const timeOff = await q(`SELECT * FROM time_off WHERE coach_id = $1 AND ends_at > NOW() ORDER BY starts_at`, [id]);
  const inquiries = await q(
    `SELECT * FROM inquiries WHERE coach_id = $1 AND (status <> 'closed' OR created_at > NOW() - INTERVAL '90 days')
     ORDER BY (status = 'new') DESC, created_at DESC LIMIT 100`, [id]);

  return {
    coach: {
      ...publicCoach(coach), email: coach.email, slotStepMinutes: coach.slot_step_minutes, bufferMinutes: coach.buffer_minutes,
      stripeConnected: Boolean(coach.stripe_account_id), payoutsReady: coach.stripe_payouts_ready,
    },
    paymentsReady: paymentsConfigured(),
    paymentsFake: process.env.PAYMENTS_MODE === "fake",
    money: {
      heldCents: money.held, releasingCents: money.releasing, sentMonthCents: money.sent_month,
      sentTotalCents: money.sent_total, offlineMonthCents: money.offline_month,
    },
    lessons: lessons.map(lessonOut),
    clients: clients.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, notes: c.notes, credits: c.credits, nextLesson: c.next_lesson, createdAt: c.created_at })),
    purchases: purchases.map(purchaseOut),
    releases: releases.map((r) => ({
      id: r.id, kind: r.kind, clientName: r.client_name, packageName: r.package_name, lessonAt: r.lesson_at,
      amountCents: r.amount_cents, feeCents: r.fee_cents, status: r.status, error: r.error, createdAt: r.created_at, sentAt: r.sent_at,
    })),
    packages: packages.map((p) => pkgOut(p, true)),
    inquiries: inquiries.map((i) => ({
      id: i.id, name: i.name, email: i.email, phone: i.phone, company: i.company, groupSize: i.group_size,
      message: i.message, status: i.status, createdAt: i.created_at,
    })),
    availability: availability.map((w) => ({ weekday: w.weekday, startMin: w.start_min, endMin: w.end_min })),
    timeOff: timeOff.map((o) => ({ id: o.id, startsAt: o.starts_at, endsAt: o.ends_at, note: o.note })),
  };
}

async function coachRoutes(req: Request, parts: string[]): Promise<Response> {
  const [a, b, c] = parts;
  const m = req.method;

  if (m === "POST" && a === "signup") {
    const d = await body(req);
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM coaches`);
    const code = process.env.COACH_SIGNUP_CODE;
    // The very first coach (the owner) can always sign up. After that, a signup code is required.
    if (n > 0 && (!code || String(d.code ?? "") !== code)) return fail(403, "Coach sign-up needs an invite code.");
    const email = normEmail(d.email), name = str(d.name, 80), slug = str(d.slug, 40).toLowerCase(), pw = String(d.password ?? "");
    const tz = validTimeZone(str(d.timezone, 60)) ? str(d.timezone, 60) : "America/Chicago";
    if (!name) return fail(400, "Add your name.");
    if (!validEmail(email)) return fail(400, "Enter a valid email address.");
    if (!validSlug(slug)) return fail(400, "Your page address can use 3–40 lowercase letters, numbers and dashes.");
    if (pw.length < 10) return fail(400, "Use at least 10 characters for your password.");
    const taken = await q(`SELECT 1 FROM coaches WHERE email = $1 OR slug = $2`, [email, slug]);
    if (taken.length) return fail(409, "That email or page address is already in use.");
    const [row] = await q(
      `INSERT INTO coaches (slug, email, password_hash, name, timezone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [slug, email, await hashPassword(pw), name, tz]);
    return json({ token: await createSession("coach", row.id) }, 201);
  }

  if (m === "POST" && a === "login") {
    const d = await body(req);
    const [row] = await q(`SELECT * FROM coaches WHERE email = $1`, [normEmail(d.email)]);
    const err = await verifyLogin("coaches", row, String(d.password ?? ""));
    if (err) return fail(401, err);
    return json({ token: await createSession("coach", row.id) });
  }

  const coachId = await sessionUser(req, "coach");
  const [coach] = coachId ? await q(`SELECT * FROM coaches WHERE id = $1`, [coachId]) : [];
  if (!coach) return fail(401, "Sign in to continue.");

  if (m === "POST" && a === "logout") { await endSession(req); return json({ ok: true }); }
  if (m === "GET" && a === "dashboard") return json(await coachDashboard(coach));

  if (m === "PUT" && a === "profile") {
    const d = await body(req);
    const slug = d.slug === undefined ? coach.slug : str(d.slug, 40).toLowerCase();
    if (!validSlug(slug)) return fail(400, "Your page address can use 3–40 lowercase letters, numbers and dashes.");
    if (slug !== coach.slug && (await q(`SELECT 1 FROM coaches WHERE slug = $1`, [slug])).length) return fail(409, "That page address is taken.");
    const tz = d.timezone === undefined ? coach.timezone : str(d.timezone, 60);
    if (!validTimeZone(tz)) return fail(400, "Unknown time zone.");
    const n = (v: unknown, cur: number, lo: number, hi: number) => {
      if (v === undefined) return cur;
      const x = int(v);
      if (!(x >= lo && x <= hi)) throw new UserError(`Pick a number from ${lo} to ${hi}.`);
      return x;
    };
    await q(
      `UPDATE coaches SET slug = $2, name = $3, headline = $4, bio = $5, location = $6, timezone = $7,
         lesson_minutes = $8, slot_step_minutes = $9, buffer_minutes = $10, min_notice_hours = $11,
         max_days_ahead = $12, cancel_window_hours = $13 WHERE id = $1`,
      [coach.id, slug,
       d.name === undefined ? coach.name : str(d.name, 80) || coach.name,
       d.headline === undefined ? coach.headline : str(d.headline, 140),
       d.bio === undefined ? coach.bio : str(d.bio, 4000),
       d.location === undefined ? coach.location : str(d.location, 140),
       tz,
       n(d.lessonMinutes, coach.lesson_minutes, 15, 240),
       n(d.slotStepMinutes, coach.slot_step_minutes, 5, 240),
       n(d.bufferMinutes, coach.buffer_minutes, 0, 120),
       n(d.minNoticeHours, coach.min_notice_hours, 0, 168),
       n(d.maxDaysAhead, coach.max_days_ahead, 1, 365),
       n(d.cancelWindowHours, coach.cancel_window_hours, 0, 168)]);
    return json({ ok: true });
  }

  if (m === "PUT" && a === "availability") {
    const d = await body(req);
    const windows = Array.isArray(d.windows) ? d.windows.slice(0, 100) : [];
    for (const w of windows) {
      if (!(int(w.weekday) >= 0 && int(w.weekday) <= 6 && int(w.startMin) >= 0 && int(w.endMin) <= 1440 && int(w.endMin) > int(w.startMin))) {
        return fail(400, "Each time window needs a day and an end after its start.");
      }
    }
    await tx(async (t) => {
      await t(`DELETE FROM availability WHERE coach_id = $1`, [coach.id]);
      for (const w of windows) {
        await t(`INSERT INTO availability (coach_id, weekday, start_min, end_min) VALUES ($1, $2, $3, $4)`,
          [coach.id, int(w.weekday), int(w.startMin), int(w.endMin)]);
      }
    });
    return json({ ok: true });
  }

  if (m === "POST" && a === "time-off") {
    const d = await body(req);
    const s = Date.parse(String(d.startsAt)), e = Date.parse(String(d.endsAt));
    if (!(s < e)) return fail(400, "The end has to be after the start.");
    await q(`INSERT INTO time_off (coach_id, starts_at, ends_at, note) VALUES ($1, $2, $3, $4)`,
      [coach.id, new Date(s), new Date(e), str(d.note, 140)]);
    return json({ ok: true }, 201);
  }
  if (m === "DELETE" && a === "time-off") {
    await q(`DELETE FROM time_off WHERE id = $1 AND coach_id = $2`, [int(b), coach.id]);
    return json({ ok: true });
  }

  if ((m === "POST" || m === "PUT") && a === "packages") {
    const d = await body(req);
    const name = str(d.name, 80), lessons = int(d.lessonCount), price = int(d.priceCents), days = int(d.expiresDays ?? 90);
    const kind = d.kind === "group" ? "group" : "private";
    const minP = kind === "group" ? int(d.minPeople) : 1, maxP = kind === "group" ? int(d.maxPeople) : 1;
    if (kind === "group" && !(minP >= 2 && maxP >= minP && maxP <= 100)) return fail(400, "Set a group size, like 3 to 6 people.");
    const offerFor = str(d.offerFor, 120);
    if (!name) return fail(400, "Name the package.");
    if (!(lessons >= 1 && lessons <= 100)) return fail(400, "Lessons must be 1 to 100.");
    if (!(price >= 100)) return fail(400, "Price must be at least $1.");
    if (!(days >= 7 && days <= 365)) return fail(400, "Use-by must be 7 to 365 days.");
    if (m === "POST") {
      const token = d.offer ? randomBytes(9).toString("base64url") : null;
      const [p] = await q(
        `INSERT INTO packages (coach_id, name, description, lesson_count, price_cents, expires_days, sort_order,
           kind, min_people, max_people, offer_token, offer_for)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [coach.id, name, str(d.description, 1000), lessons, price, days, int(d.sortOrder) || 0, kind, minP, maxP, token, offerFor]);
      return json({ package: pkgOut(p, true) }, 201);
    }
    // Editing changes the package for future buyers only; past purchases keep their own copy of the terms.
    const [p] = await q(
      `UPDATE packages SET name = $3, description = $4, lesson_count = $5, price_cents = $6, expires_days = $7,
         active = $8, sort_order = $9, kind = $10, min_people = $11, max_people = $12, offer_for = $13
       WHERE id = $1 AND coach_id = $2 RETURNING *`,
      [int(b), coach.id, name, str(d.description, 1000), lessons, price, days, d.active !== false, int(d.sortOrder) || 0,
       kind, minP, maxP, offerFor]);
    if (!p) return fail(404, "Package not found.");
    return json({ package: pkgOut(p, true) });
  }

  if (m === "POST" && a === "starter-packages") {
    // One-tap starting lineup: $125 single down to $100/lesson, plus $50/person small groups.
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM packages WHERE coach_id = $1`, [coach.id]);
    if (n > 0) return fail(409, "You already have packages.");
    const starter: [string, string, number, number, string, number, number, number][] = [
      ["Single Lesson", "One private lesson.", 1, 12500, "private", 1, 1, 10],
      ["5-Lesson Pack", "Five private lessons at $115 each.", 5, 57500, "private", 1, 1, 20],
      ["10-Lesson Pack", "Ten private lessons at $100 each. Best value.", 10, 100000, "private", 1, 1, 30],
      ["Small Group Lesson", "Bring your crew: one lesson for a group of 3 to 6. Price is per person.", 1, 5000, "group", 3, 6, 40],
    ];
    for (const [name, desc, count, price, kind, minP, maxP, sort] of starter) {
      await q(
        `INSERT INTO packages (coach_id, name, description, lesson_count, price_cents, expires_days, sort_order, kind, min_people, max_people)
         VALUES ($1, $2, $3, $4, $5, 90, $6, $7, $8, $9)`,
        [coach.id, name, desc, count, price, sort, kind, minP, maxP]);
    }
    return json({ ok: true }, 201);
  }

  if (m === "PUT" && a === "inquiries") {
    const d = await body(req);
    const status = ["new", "replied", "closed"].includes(d.status) ? d.status : "replied";
    await q(`UPDATE inquiries SET status = $3 WHERE id = $1 AND coach_id = $2`, [int(b), coach.id, status]);
    return json({ ok: true });
  }

  if (m === "PUT" && a === "clients") {
    const d = await body(req);
    const [cl] = await q(`SELECT * FROM clients WHERE id = $1 AND coach_id = $2`, [int(b), coach.id]);
    if (!cl) return fail(404, "Client not found.");
    if (d.notes !== undefined) await q(`UPDATE clients SET notes = $2 WHERE id = $1`, [cl.id, str(d.notes, 4000)]);
    if (d.phone !== undefined) await q(`UPDATE clients SET phone = $2 WHERE id = $1`, [cl.id, str(d.phone, 30)]);
    if (d.tempPassword !== undefined) {
      const pw = String(d.tempPassword);
      if (pw.length < 8) return fail(400, "Temporary password needs at least 8 characters.");
      await q(`UPDATE clients SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`, [cl.id, await hashPassword(pw)]);
      await q(`DELETE FROM sessions WHERE role = 'client' AND user_id = $1`, [cl.id]);
    }
    return json({ ok: true });
  }

  if (m === "POST" && a === "clients" && !b) {
    // Coach adds a client by hand (e.g. someone who pays in person). They can sign in later with this password.
    const d = await body(req);
    const email = normEmail(d.email), name = str(d.name, 80), pw = String(d.tempPassword ?? "");
    if (!name) return fail(400, "Add the client's name.");
    if (!validEmail(email)) return fail(400, "Enter a valid email address.");
    if (pw.length < 8) return fail(400, "Temporary password needs at least 8 characters.");
    if ((await q(`SELECT 1 FROM clients WHERE coach_id = $1 AND email = $2`, [coach.id, email])).length) return fail(409, "That client already exists.");
    const [row] = await q(
      `INSERT INTO clients (coach_id, email, password_hash, name, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [coach.id, email, await hashPassword(pw), name, str(d.phone, 30)]);
    return json({ id: row.id }, 201);
  }

  if (m === "POST" && a === "purchases" && b === "offline") {
    // Package paid outside the site (cash, Zelle, Venmo). Gives credits; nothing is held.
    const d = await body(req);
    const [cl] = await q(`SELECT id FROM clients WHERE id = $1 AND coach_id = $2`, [int(d.clientId), coach.id]);
    const [pkg] = await q(`SELECT * FROM packages WHERE id = $1 AND coach_id = $2`, [int(d.packageId), coach.id]);
    if (!cl || !pkg) return fail(404, "Pick a client and a package.");
    const people = partySize(pkg, d.people ?? pkg.min_people);
    const amount = d.amountCents === undefined ? packageTotal(pkg, people) : int(d.amountCents);
    if (!(amount >= 0)) return fail(400, "Enter the amount paid.");
    await q(
      `INSERT INTO purchases (coach_id, client_id, package_id, package_name, lessons_total, amount_cents, method, status, paid_at, expires_at,
         package_kind, party_size)
       VALUES ($1, $2, $3, $4, $5, $6, 'offline', 'paid', NOW(), NOW() + make_interval(days => $7), $8, $9)`,
      [coach.id, cl.id, pkg.id, pkg.name, pkg.lesson_count, amount, pkg.expires_days, pkg.kind, people]);
    return json({ ok: true }, 201);
  }

  if (m === "POST" && a === "purchases" && c === "refund") {
    // Refund what's still held: cancels the purchase's upcoming lessons and returns the unreleased balance.
    const purchaseId = int(b);
    const r = await tx(async (t) => {
      const [p] = await t(`SELECT * FROM purchases WHERE id = $1 AND coach_id = $2 FOR UPDATE`, [purchaseId, coach.id]);
      if (!p || p.status !== "paid") throw new UserError("Only paid packages can be refunded.", 404);
      await t(`UPDATE lessons SET status = 'canceled', closed_at = NOW() WHERE purchase_id = $1 AND status = 'booked'`, [p.id]);
      const amount = p.amount_cents - p.released_cents - p.refunded_cents;
      await t(`UPDATE purchases SET status = 'refunded', refunded_cents = refunded_cents + $2 WHERE id = $1`, [p.id, Math.max(0, amount)]);
      return { p, amount };
    });
    if (r.p.method === "card" && r.amount > 0) {
      try {
        await payments().refund({ paymentIntent: r.p.stripe_payment_intent, amountCents: r.amount, key: `refund-${r.p.id}` });
      } catch (e: any) {
        // Put the purchase back so nothing is lost; the coach can try again.
        await q(`UPDATE purchases SET status = 'paid', refunded_cents = refunded_cents - $2 WHERE id = $1`, [r.p.id, r.amount]);
        return fail(502, `Stripe refused the refund: ${e?.message ?? e}`);
      }
    }
    return json({ refundedCents: r.p.method === "card" ? r.amount : 0 });
  }

  if (m === "POST" && a === "purchases" && c === "keep-balance") {
    const purchaseId = int(b);
    const kept = await tx(async (t) => {
      const [p] = await t(`SELECT * FROM purchases WHERE id = $1 AND coach_id = $2`, [purchaseId, coach.id]);
      if (!p || p.status !== "paid") throw new UserError("Package not found.", 404);
      if (p.expires_at && +new Date(p.expires_at) > Date.now()) throw new UserError("You can keep the unused balance once the package expires.");
      return recordForfeit(t, p.id);
    });
    const sent = await sendPendingReleases(coach.id).catch(() => null);
    return json({ keptCents: kept, sent });
  }

  if (m === "POST" && a === "lessons" && !b) {
    const d = await body(req);
    const [cl] = await q(`SELECT id FROM clients WHERE id = $1 AND coach_id = $2`, [int(d.clientId), coach.id]);
    if (!cl) return fail(404, "Pick a client.");
    const l = await bookLesson(coach, cl.id, Date.parse(String(d.startsAt)), str(d.note, 500), true, int(d.purchaseId) || 0);
    return json({ lesson: lessonOut(l) }, 201);
  }

  if (m === "POST" && a === "lessons" && c === "reschedule") {
    const d = await body(req);
    const start = Date.parse(String(d.startsAt));
    const l = await tx(async (t) => {
      await t(`SELECT pg_advisory_xact_lock($1)`, [coach.id]);
      const [l] = await t(`SELECT * FROM lessons WHERE id = $1 AND coach_id = $2 FOR UPDATE`, [int(b), coach.id]);
      if (!l || l.status !== "booked") throw new UserError("Only upcoming lessons can be moved.", 404);
      await assertBookable(t, coach, start, l.id, true);
      const [u] = await t(`UPDATE lessons SET starts_at = $2, ends_at = $3 WHERE id = $1 RETURNING *`,
        [l.id, new Date(start), new Date(start + coach.lesson_minutes * 60_000)]);
      return u;
    });
    return json({ lesson: lessonOut(l) });
  }

  if (m === "POST" && a === "lessons" && c === "status") {
    const d = await body(req);
    const status = String(d.status);
    if (![...RELEASES, "canceled"].includes(status)) return fail(400, "Unknown status.");
    const l = await tx(async (t) => {
      const [l] = await t(`SELECT * FROM lessons WHERE id = $1 AND coach_id = $2 FOR UPDATE`, [int(b), coach.id]);
      if (!l) throw new UserError("Lesson not found.", 404);
      if (l.status !== "booked") throw new UserError("This lesson is already closed out.", 409);
      if (RELEASES.includes(status) && +new Date(l.starts_at) > Date.now() && status !== "late_cancel") {
        throw new UserError("You can mark a lesson done once it has started.");
      }
      const [u] = await t(`UPDATE lessons SET status = $2, closed_at = NOW() WHERE id = $1 RETURNING *`, [l.id, status]);
      if (RELEASES.includes(status)) await recordLessonRelease(t, l.id);
      return u;
    });
    const sent = RELEASES.includes(status) ? await sendPendingReleases(coach.id).catch(() => null) : null;
    return json({ lesson: lessonOut(l), sent });
  }

  if (m === "POST" && a === "releases" && b === "send") {
    return json(await sendPendingReleases(coach.id));
  }

  if (m === "POST" && a === "stripe" && b === "connect") {
    if (!paymentsConfigured()) return fail(503, "Add STRIPE_SECRET_KEY to the site's environment variables first.");
    let accountId = coach.stripe_account_id;
    if (!accountId) {
      accountId = await payments().createConnectAccount(coach.email, coach.id);
      await q(`UPDATE coaches SET stripe_account_id = $2 WHERE id = $1`, [coach.id, accountId]);
    }
    const back = `${origin(req)}/admin?tab=money&stripe=return`;
    return json({ url: await payments().onboardingLink(accountId, `${origin(req)}/admin?tab=money&stripe=refresh`, back) });
  }

  if (m === "POST" && a === "stripe" && b === "refresh") {
    if (!coach.stripe_account_id) return json({ payoutsReady: false });
    const ready = await payments().accountReady(coach.stripe_account_id);
    await q(`UPDATE coaches SET stripe_payouts_ready = $2 WHERE id = $1`, [coach.id, ready]);
    const sent = ready ? await sendPendingReleases(coach.id).catch(() => null) : null;
    return json({ payoutsReady: ready, sent });
  }

  if (m === "GET" && a === "stripe" && b === "dashboard") {
    if (!coach.stripe_account_id) return fail(400, "Connect payouts first.");
    return json({ url: await payments().dashboardLink(coach.stripe_account_id) });
  }

  return fail(404, "Not found.");
}

// ---------- Stripe webhook ----------

async function stripeWebhook(req: Request): Promise<Response> {
  const raw = await req.text();
  let event;
  try {
    event = await payments().parseWebhook(raw, req.headers.get("stripe-signature") ?? "");
  } catch (e: any) {
    return fail(400, `Webhook signature check failed: ${e?.message ?? e}`);
  }
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const id = int(obj.metadata?.purchase_id);
      if (id) await confirmPurchase(id);
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const id = int(obj.metadata?.purchase_id);
      if (id) await q(`UPDATE purchases SET status = 'canceled' WHERE id = $1 AND status = 'pending'`, [id]);
      break;
    }
    case "account.updated": {
      const ready = Boolean(obj.payouts_enabled) && obj.capabilities?.transfers === "active";
      const rows = await q(`UPDATE coaches SET stripe_payouts_ready = $2 WHERE stripe_account_id = $1 RETURNING id`, [obj.id, ready]);
      if (ready && rows[0]) await sendPendingReleases(rows[0].id).catch(() => {});
      break;
    }
  }
  return json({ received: true });
}

// ---------- entry ----------

export default async (req: Request) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const parts = path.split("/").slice(2).map(decodeURIComponent);   // drop "", "api"
  try {
    if (parts[0] === "stripe" && parts[1] === "webhook" && req.method === "POST") return await stripeWebhook(req);
    if (parts[0] === "coach") return await coachRoutes(req, parts.slice(1));
    if (parts[0] === "c" && parts[1]) return await clientRoutes(req, parts[1].toLowerCase(), parts.slice(2));
    if (parts[0] === "directory" && req.method === "GET") {
      const rows = await q(`SELECT ${COACH_PUBLIC} FROM coaches ORDER BY created_at LIMIT 200`);
      return json({ coaches: rows.map(publicCoach) });
    }
    return fail(404, "Not found.");
  } catch (e: any) {
    if (e instanceof UserError) return fail(e.status, e.message);
    console.error(e);
    return fail(500, "Something went wrong. Try again.");
  }
};

export const config: Config = { path: "/api/*" };
