// End-to-end API test against a real Postgres with fake payments.
// Run: COACH_DB_URL=postgres://... PAYMENTS_MODE=fake npm test   (the database must have the migration applied)
import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonShare } from "../src/money.ts";
import { zonedToUtc, openSlots, localDate } from "../src/time.ts";

process.env.PAYMENTS_MODE ??= "fake";
const { default: handler } = await import("../netlify/functions/api.mts");
const { q } = await import("../src/db.ts");

async function call(method, path, body, token) {
  const res = await handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };

test("time zone conversion handles DST", () => {
  // 9:00 in Chicago: CDT (UTC-5) in July, CST (UTC-6) in December.
  assert.equal(new Date(zonedToUtc("2026-07-01", 540, "America/Chicago")).toISOString(), "2026-07-01T14:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-12-01", 540, "America/Chicago")).toISOString(), "2026-12-01T15:00:00.000Z");
  // DST start day (Mar 8 2026): 9:00 is already CDT.
  assert.equal(new Date(zonedToUtc("2026-03-08", 540, "America/Chicago")).toISOString(), "2026-03-08T14:00:00.000Z");
});

test("package splits add up exactly", () => {
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += lessonShare(10000, 3, i, sum);
  assert.equal(sum, 10000);
  assert.equal(lessonShare(10000, 3, 0, 0), 3333);
  assert.equal(lessonShare(10000, 3, 2, 6666), 3334);
});

test("slots respect windows, notice and busy times", () => {
  const rules = { timezone: "America/Chicago", lesson_minutes: 60, slot_step_minutes: 30, buffer_minutes: 0, min_notice_hours: 0, max_days_ahead: 400 };
  const now = Date.parse("2026-12-01T00:00:00Z");
  const windows = [{ weekday: 2, start_min: 540, end_min: 660 }]; // Tue 9–11
  const busy = [{ start: Date.parse("2026-12-01T15:00:00Z"), end: Date.parse("2026-12-01T16:00:00Z") }]; // 9–10 CST
  const s = openSlots(rules, windows, busy, "2026-12-01", 1, now).map((t) => new Date(t).toISOString());
  assert.deepEqual(s, ["2026-12-01T16:00:00.000Z"]); // only 10:00 fits (9:30 overlaps)
});

test("full flow: buy, book, reschedule, cancel, complete, release, refund", async () => {
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries RESTART IDENTITY CASCADE`);

  // Owner signs up with no code; a second coach can't without one.
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Sam Coach", email: "sam@example.com", slug: "sam", password: "longpassword1", timezone: "America/Chicago" }), 201).token;
  assert.equal((await call("POST", "/api/coach/signup", { name: "X", email: "x@example.com", slug: "xx-coach", password: "longpassword1" })).status, 403);

  ok(await call("PUT", "/api/coach/profile", { bio: "Hi", minNoticeHours: 1, cancelWindowHours: 24, maxDaysAhead: 60 }, coach));
  // Open every day 6:00–22:00.
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 360, endMin: 1320 })) }, coach));
  const pkg = ok(await call("POST", "/api/coach/packages", { name: "4 Pack", lessonCount: 4, priceCents: 25000 }, coach), 201).package;
  const pkg3 = ok(await call("POST", "/api/coach/packages", { name: "3 Pack", lessonCount: 3, priceCents: 10000 }, coach), 201).package;

  const pub = ok(await call("GET", "/api/c/sam"));
  assert.equal(pub.packages.length, 2);

  // Client signs up and buys.
  const client = ok(await call("POST", "/api/c/sam/signup", { name: "Pat Client", email: "pat@example.com", password: "password12" }), 201).token;
  const co = ok(await call("POST", "/api/c/sam/checkout", { packageId: pkg.id }, client));
  assert.match(co.url, /\/sam\?paid=\d+/);
  assert.equal(ok(await call("POST", `/api/c/sam/purchases/${co.purchaseId}/confirm`, {}, client)).paid, true);
  let me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.creditsRemaining, 4);

  // Book two days out, then reschedule, then cancel (credit comes back).
  const from = localDate(Date.now() + 2 * 864e5, "America/Chicago");
  const slots = ok(await call("GET", `/api/c/sam/slots?from=${from}&days=1`)).slots;
  assert.ok(slots.length > 10);
  const l1 = ok(await call("POST", "/api/c/sam/lessons", { startsAt: slots[0] }, client), 201).lesson;

  // Someone else can't take the same slot.
  const other = ok(await call("POST", "/api/c/sam/signup", { name: "Other", email: "o@example.com", password: "password12" }), 201).token;
  ok(await call("POST", "/api/c/sam/purchases/" + ok(await call("POST", "/api/c/sam/checkout", { packageId: pkg3.id }, other)).purchaseId + "/confirm", {}, other));
  assert.equal((await call("POST", "/api/c/sam/lessons", { startsAt: slots[0] }, other)).status, 409);
  assert.equal((await call("POST", "/api/c/sam/lessons", { startsAt: slots[1] }, other)).status, 409, "30 min later overlaps a 60 min lesson");

  ok(await call("POST", `/api/c/sam/lessons/${l1.id}/reschedule`, { startsAt: slots[4] }, client));
  me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.creditsRemaining, 3);
  ok(await call("POST", `/api/c/sam/lessons/${l1.id}/cancel`, {}, client));
  me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.creditsRemaining, 4);

  // Client can't cancel inside the 24h window.
  const soon = ok(await call("POST", "/api/coach/lessons", { clientId: 1, startsAt: new Date(Date.now() + 3 * 3600e3).toISOString() }, coach), 201).lesson;
  assert.equal((await call("POST", `/api/c/sam/lessons/${soon.id}/cancel`, {}, client)).status, 403);
  // Can't mark a future lesson completed.
  assert.equal((await call("POST", `/api/coach/lessons/${soon.id}/status`, { status: "completed" }, coach)).status, 400);
  ok(await call("POST", `/api/coach/lessons/${soon.id}/status`, { status: "canceled" }, coach));

  // Coach logs a lesson that already happened and marks it done. Payouts not connected yet -> waits.
  const past = ok(await call("POST", "/api/coach/lessons", { clientId: 1, startsAt: new Date(Date.now() - 2 * 3600e3).toISOString() }, coach), 201).lesson;
  const done = ok(await call("POST", `/api/coach/lessons/${past.id}/status`, { status: "completed" }, coach));
  assert.equal(done.sent.waiting, 1);
  assert.equal((await call("POST", `/api/coach/lessons/${past.id}/status`, { status: "completed" }, coach)).status, 409, "no double release");

  let dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.money.heldCents, 25000 - 6250 + 10000);
  assert.equal(dash.money.releasingCents, 6250);

  // Connect payouts (fake Stripe) -> pending release goes out.
  ok(await call("POST", "/api/coach/stripe/connect", {}, coach));
  const ref = ok(await call("POST", "/api/coach/stripe/refresh", {}, coach));
  assert.equal(ref.payoutsReady, true);
  assert.equal(ref.sent.sent, 1);
  dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.money.releasingCents, 0);
  assert.equal(dash.money.sentTotalCents, 6250);

  // 3-pack: three no-shows release 3333 + 3333 + 3334.
  for (let i = 0; i < 3; i++) {
    const l = ok(await call("POST", "/api/coach/lessons", { clientId: 2, startsAt: new Date(Date.now() - (30 + i * 2) * 3600e3).toISOString() }, coach), 201).lesson;
    ok(await call("POST", `/api/coach/lessons/${l.id}/status`, { status: "no_show" }, coach));
  }
  const [p3] = await q(`SELECT released_cents FROM purchases WHERE client_id = 2`);
  assert.equal(p3.released_cents, 10000);
  assert.equal((await call("POST", "/api/coach/lessons", { clientId: 2, startsAt: new Date(Date.now() - 50 * 3600e3).toISOString() }, coach)).status, 402, "no credits left");

  // Refund the rest of Pat's 4-pack: 3 lessons unused = 18750.
  const r = ok(await call("POST", `/api/coach/purchases/${co.purchaseId}/refund`, {}, coach));
  assert.equal(r.refundedCents, 18750);
  dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.money.heldCents, 0);
  assert.equal(dash.money.sentTotalCents, 16250);

  // Offline (Zelle/cash) purchase gives credits, holds nothing.
  ok(await call("POST", "/api/coach/purchases/offline", { clientId: 1, packageId: pkg3.id }, coach), 201);
  me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.creditsRemaining, 3);
  dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.money.heldCents, 0);

  // Wrong coach's client token doesn't work, and bad passwords lock out.
  assert.equal((await call("GET", "/api/coach/dashboard", null, client)).status, 401);
  for (let i = 0; i < 5; i++) await call("POST", "/api/c/sam/login", { email: "pat@example.com", password: "nope" });
  assert.match((await call("POST", "/api/c/sam/login", { email: "pat@example.com", password: "password12" })).body.error, /Too many/);
});



test("groups, private offers, quote requests, starter packages", async () => {
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries RESTART IDENTITY CASCADE`);
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Sam", email: "sam@example.com", slug: "sam", password: "longpassword1" }), 201).token;
  ok(await call("PUT", "/api/coach/profile", { minNoticeHours: 0 }, coach));
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 0, endMin: 1440 })) }, coach));

  // Starter lineup: $125 single, $115 and $100 packs, $50/person group.
  ok(await call("POST", "/api/coach/starter-packages", {}, coach), 201);
  assert.equal((await call("POST", "/api/coach/starter-packages", {}, coach)).status, 409);
  const pub = ok(await call("GET", "/api/c/sam"));
  assert.deepEqual(pub.packages.map((p) => [p.name, p.priceCents / p.lessonCount]),
    [["Single Lesson", 12500], ["5-Lesson Pack", 11500], ["10-Lesson Pack", 10000], ["Small Group Lesson", 5000]]);
  const group = pub.packages.find((p) => p.kind === "group");

  // Group of 4 pays $200; group of 2 is refused.
  const client = ok(await call("POST", "/api/c/sam/signup", { name: "Pat", email: "pat@example.com", password: "password12" }), 201).token;
  assert.equal((await call("POST", "/api/c/sam/checkout", { packageId: group.id, people: 2 }, client)).status, 400);
  const g = ok(await call("POST", "/api/c/sam/checkout", { packageId: group.id, people: 4 }, client));
  ok(await call("POST", `/api/c/sam/purchases/${g.purchaseId}/confirm`, {}, client));
  const single = pub.packages.find((p) => p.name === "Single Lesson");
  const s = ok(await call("POST", "/api/c/sam/checkout", { packageId: single.id, people: 9 }, client));
  ok(await call("POST", `/api/c/sam/purchases/${s.purchaseId}/confirm`, {}, client));
  const [gp] = await q(`SELECT amount_cents, party_size, package_kind FROM purchases WHERE id = $1`, [g.purchaseId]);
  assert.deepEqual(gp, { amount_cents: 20000, party_size: 4, package_kind: "group" });
  const [sp] = await q(`SELECT amount_cents, party_size FROM purchases WHERE id = $1`, [s.purchaseId]);
  assert.deepEqual(sp, { amount_cents: 12500, party_size: 1 }, "headcount ignored for private lessons");

  // Client picks which credit to use; the group lesson shows as a group of 4.
  let me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.creditsRemaining, 2);
  const slot = new Date(Math.ceil((Date.now() + 3 * 864e5) / 36e5) * 36e5).toISOString();
  const gl = ok(await call("POST", "/api/c/sam/lessons", { startsAt: slot, purchaseId: g.purchaseId }, client), 201).lesson;
  assert.equal(gl.kind, "group"); assert.equal(gl.partySize, 4);
  me = ok(await call("GET", "/api/c/sam/me", null, client));
  assert.equal(me.credits.length, 1); assert.equal(me.credits[0].kind, "private");

  // Closing out a group lesson releases the full $200.
  const past = ok(await call("POST", "/api/coach/lessons", { clientId: 1, purchaseId: s.purchaseId, startsAt: new Date(Date.now() - 2 * 36e5).toISOString() }, coach), 201).lesson;
  assert.equal(past.kind, "private");
  await q(`UPDATE lessons SET starts_at = NOW() - INTERVAL '3 hours', ends_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [gl.id]);
  ok(await call("POST", `/api/coach/lessons/${gl.id}/status`, { status: "completed" }, coach));
  const [r] = await q(`SELECT amount_cents FROM releases WHERE lesson_id = $1`, [gl.id]);
  assert.equal(r.amount_cents, 20000);

  // Corporate: quote request -> private offer link -> purchase.
  ok(await call("POST", "/api/c/sam/inquiries", { name: "Dana HR", email: "dana@acme.com", company: "Acme", groupSize: "20", message: "Monthly wellness sessions" }), 201);
  ok(await call("POST", "/api/c/sam/inquiries", { name: "Bot", email: "bot@x.com", website: "spam" }));
  let dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.inquiries.length, 1);
  assert.equal(dash.inquiries[0].status, "new");
  const offer = ok(await call("POST", "/api/coach/packages", { name: "Acme Wellness", lessonCount: 4, priceCents: 160000, offer: true, offerFor: "Acme" }, coach), 201).package;
  assert.ok(offer.offerToken);
  assert.equal(ok(await call("GET", "/api/c/sam")).packages.some((p) => p.isOffer), false, "offers stay off the public page");
  assert.equal(ok(await call("GET", `/api/c/sam?offer=${offer.offerToken}`)).offer.name, "Acme Wellness");
  const dana = ok(await call("POST", "/api/c/sam/signup", { name: "Dana", email: "dana@acme.com", password: "password12" }), 201).token;
  assert.equal((await call("POST", "/api/c/sam/checkout", { packageId: offer.id }, dana)).status, 404, "needs the link");
  ok(await call("POST", "/api/c/sam/checkout", { packageId: offer.id, offer: offer.offerToken }, dana));
  ok(await call("PUT", `/api/coach/inquiries/${dash.inquiries[0].id}`, { status: "replied" }, coach));
  dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.inquiries[0].status, "replied");

  // Group bought in person: amount defaults to $50 x people.
  ok(await call("POST", "/api/coach/purchases/offline", { clientId: 1, packageId: group.id, people: 5 }, coach), 201);
  const [off] = await q(`SELECT amount_cents, party_size FROM purchases WHERE method = 'offline'`);
  assert.deepEqual(off, { amount_cents: 25000, party_size: 5 });
});
