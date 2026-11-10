// End-to-end API test against a real Postgres with fake payments.
// Run: COACH_DB_URL=postgres://... PAYMENTS_MODE=fake npm test   (the database must have the migration applied)
import { test } from "node:test";
import assert from "node:assert/strict";
import { lessonShare } from "../src/money.ts";
import { zonedToUtc, openSlots, localDate } from "../src/time.ts";

process.env.PAYMENTS_MODE ??= "fake";
const { default: handler } = await import("../netlify/functions/api.mts");
const { q } = await import("../src/db.ts");

async function call(method, path, body, token, extra = {}) {
  const res = await handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
// The first coach account gets the site's own setup (src/defaults.ts). Generic tests start from a blank coach.
async function blankCoach() {
  await q(`DELETE FROM packages`); await q(`DELETE FROM availability`);
  await q(`UPDATE coaches SET venues = '', zelle_handle = '', cashapp_tag = '', person_name = '', credentials = '', contact_email = '', contact_phone = '', cancel_window_hours = 24, min_notice_hours = 12`);
}

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
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries, payment_proofs RESTART IDENTITY CASCADE`);

  // Owner signs up with no code; a second coach can't without one.
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Sam Coach", email: "sam@example.com", slug: "sam", password: "longpassword1", timezone: "America/Chicago" }), 201).token;
  await blankCoach();
  assert.equal((await call("POST", "/api/coach/signup", { name: "X", email: "x@example.com", slug: "xx-coach", password: "longpassword1" })).status, 403);

  ok(await call("PUT", "/api/coach/profile", { bio: "Hi", minNoticeHours: 1, cancelWindowHours: 24, maxDaysAhead: 60 }, coach));
  // Open every day 6:00–22:00.
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 360, endMin: 1320 })) }, coach));
  const pkg = ok(await call("POST", "/api/coach/packages", { name: "4 Pack", lessonCount: 4, priceCents: 25000 }, coach), 201).package;
  const pkg3 = ok(await call("POST", "/api/coach/packages", { name: "3 Pack", lessonCount: 3, priceCents: 10000 }, coach), 201).package;

  const pub = ok(await call("GET", "/api/c/sam"));
  assert.equal(pub.packages.length, 2);

  // Client signs up and buys.
  const client = ok(await call("POST", "/api/c/sam/signup", { phone: "4695550100", name: "Pat Client", email: "pat@example.com", password: "password12" }), 201).token;
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
  const other = ok(await call("POST", "/api/c/sam/signup", { phone: "4695550100", name: "Other", email: "o@example.com", password: "password12" }), 201).token;
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
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries, payment_proofs RESTART IDENTITY CASCADE`);
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Sam", email: "sam@example.com", slug: "sam", password: "longpassword1" }), 201).token;
  await blankCoach();
  ok(await call("PUT", "/api/coach/profile", { minNoticeHours: 0 }, coach));
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 0, endMin: 1440 })) }, coach));

  // Starter lineup: $125 single, $110 and $100 packs, $50/person group.
  ok(await call("POST", "/api/coach/starter-packages", {}, coach), 201);
  assert.equal((await call("POST", "/api/coach/starter-packages", {}, coach)).status, 409);
  const pub = ok(await call("GET", "/api/c/sam"));
  assert.deepEqual(pub.packages.map((p) => [p.name, p.priceCents / p.lessonCount]),
    [["12-Lesson Pack", 10000], ["8-Lesson Pack", 11000], ["Single Lesson", 12500], ["Small Group Lesson", 5000]]);
  const group = pub.packages.find((p) => p.kind === "group");

  // Group of 4 pays $200; group of 2 is refused.
  const client = ok(await call("POST", "/api/c/sam/signup", { phone: "4695550100", name: "Pat", email: "pat@example.com", password: "password12" }), 201).token;
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
  ok(await call("POST", "/api/c/sam/inquiries", { phone: "4695550100", name: "Dana HR", email: "dana@acme.com", company: "Acme", groupSize: "20", message: "Monthly wellness sessions" }), 201);
  ok(await call("POST", "/api/c/sam/inquiries", { phone: "4695550100", name: "Bot", email: "bot@x.com", website: "spam" }));
  let dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.inquiries.length, 1);
  assert.equal(dash.inquiries[0].status, "new");
  const offer = ok(await call("POST", "/api/coach/packages", { name: "Acme Wellness", lessonCount: 4, priceCents: 160000, offer: true, offerFor: "Acme" }, coach), 201).package;
  assert.ok(offer.offerToken);
  assert.equal(ok(await call("GET", "/api/c/sam")).packages.some((p) => p.isOffer), false, "offers stay off the public page");
  assert.equal(ok(await call("GET", `/api/c/sam?offer=${offer.offerToken}`)).offer.name, "Acme Wellness");
  const dana = ok(await call("POST", "/api/c/sam/signup", { phone: "4695550100", name: "Dana", email: "dana@acme.com", password: "password12" }), 201).token;
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

test("pay by Zelle or Cash App without an account, coach approves", async () => {
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries, payment_proofs RESTART IDENTITY CASCADE`);
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Sam", email: "sam@example.com", slug: "sam", password: "longpassword1" }), 201).token;
  await blankCoach();
  ok(await call("PUT", "/api/coach/profile", { minNoticeHours: 0, zelleHandle: "pay@sam.example", cashappTag: "SamCoaching" }, coach));
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 0, endMin: 1440 })) }, coach));
  ok(await call("POST", "/api/coach/starter-packages", {}, coach), 201);
  const pub = ok(await call("GET", "/api/c/sam"));
  assert.deepEqual(pub.coach.payment, { zelle: "pay@sam.example", cashapp: "$SamCoaching", note: "" });
  const eight = pub.packages.find((p) => p.lessonCount === 8);
  const group = pub.packages.find((p) => p.kind === "group");
  const proof = "data:image/jpeg;base64," + Buffer.alloc(2000, 7).toString("base64");

  // Missing screenshot / email are refused.
  assert.equal((await call("POST", "/api/c/sam/manual-purchase", { phone: "4695550100", packageId: eight.id, method: "zelle", name: "Ana", email: "ana@example.com" })).status, 400);
  assert.equal((await call("POST", "/api/c/sam/manual-purchase", { phone: "4695550100", packageId: eight.id, method: "zelle", name: "Ana", proof })).status, 400);

  // New email: account created and signed in on this device; nothing to book until approved.
  const r = ok(await call("POST", "/api/c/sam/manual-purchase", { phone: "4695550100", packageId: eight.id, method: "zelle", name: "Ana", email: "Ana@Example.com", proof }), 201);
  assert.equal(r.accountCreated, true); assert.ok(r.token); assert.equal(r.amountCents, 88000); assert.equal(r.needsPassword, true);
  let me = ok(await call("GET", "/api/c/sam/me", null, r.token));
  assert.equal(me.creditsRemaining, 0);
  assert.equal(me.purchases[0].status, "pending");
  assert.equal(me.client.hasPassword, false);
  assert.match((await call("POST", "/api/c/sam/login", { email: "ana@example.com", password: "whatever1" })).body.error, /doesn't have a password/);

  // Same email again from another device: linked to the same account, but not signed in.
  const r2 = ok(await call("POST", "/api/c/sam/manual-purchase", { phone: "4695550100", packageId: group.id, people: 4, method: "cashapp", name: "Ana", email: "ana@example.com", proof }), 201);
  assert.equal(r2.accountCreated, false); assert.equal(r2.token, null); assert.equal(r2.amountCents, 20000);

  // Coach sees both, views the screenshot, approves one and rejects the other.
  let dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.reviews.length, 2);
  assert.equal(dash.reviews[0].clientEmail, "ana@example.com");
  assert.equal(dash.reviews[0].methodLabel, "Zelle");
  assert.match(ok(await call("GET", `/api/coach/purchases/${r.purchaseId}/proof`, null, coach)).dataUrl, /^data:image\/jpeg;base64,/);
  ok(await call("POST", `/api/coach/purchases/${r.purchaseId}/approve`, {}, coach));
  assert.equal((await call("POST", `/api/coach/purchases/${r.purchaseId}/approve`, {}, coach)).status, 409);
  ok(await call("POST", `/api/coach/purchases/${r2.purchaseId}/reject`, { note: "Couldn't find this payment" }, coach));
  dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.reviews.length, 0);

  // Approved: 8 lessons to book. Rejected one shows with the note.
  me = ok(await call("GET", "/api/c/sam/me", null, r.token));
  assert.equal(me.creditsRemaining, 8);
  assert.equal(me.credits[0].expiresAt, null, "packages no longer expire");
  assert.equal(me.purchases.find((p) => p.id === r2.purchaseId).reviewNote, "Couldn't find this payment");
  const slot = new Date(Math.ceil((Date.now() + 2 * 864e5) / 36e5) * 36e5).toISOString();
  ok(await call("POST", "/api/c/sam/lessons", { startsAt: slot }, r.token), 201);

  // Client sets a password and can sign in anywhere.
  ok(await call("POST", "/api/c/sam/password", { password: "newpassword9" }, r.token));
  ok(await call("POST", "/api/c/sam/login", { email: "ana@example.com", password: "newpassword9" }));

  // Completing a Zelle-paid lesson tracks earnings without any transfer.
  await q(`UPDATE lessons SET starts_at = NOW() - INTERVAL '2 hours', ends_at = NOW() - INTERVAL '1 hour'`);
  const [lesson] = await q(`SELECT id FROM lessons`);
  ok(await call("POST", `/api/coach/lessons/${lesson.id}/status`, { status: "completed" }, coach));
  const [rel] = await q(`SELECT status, amount_cents FROM releases`);
  assert.deepEqual(rel, { status: "not_held", amount_cents: 11000 });

  // Contact details and credentials are saved and shown exactly as typed.
  ok(await call("PUT", "/api/coach/profile", { contactEmail: "SimmonsMMA26@gmail.com", contactPhone: "(469) 307 6899", credentials: "200+ grappling matches · Coach at Fortis MMA", zelleHandle: "4693076899" }, coach));
  const pc = ok(await call("GET", "/api/c/sam")).coach;
  assert.equal(pc.contactEmail, "SimmonsMMA26@gmail.com"); assert.equal(pc.contactPhone, "(469) 307 6899");
  assert.equal(pc.credentials, "200+ grappling matches · Coach at Fortis MMA"); assert.equal(pc.payment.zelle, "4693076899");
  assert.equal((await call("PUT", "/api/coach/profile", { contactEmail: "not-an-email" }, coach)).status, 400);
  ok(await call("PUT", "/api/coach/profile", { location: "Dallas, TX", venues: "Fortis MMA · Iron MMA · In-home training" }, coach));
  const pv = ok(await call("GET", "/api/c/sam")).coach;
  assert.equal(pv.location, "Dallas, TX"); assert.equal(pv.venues, "Fortis MMA · Iron MMA · In-home training");

  // A bad $cashtag is refused.
  assert.equal((await call("PUT", "/api/coach/profile", { cashappTag: "$not valid!" }, coach)).status, 400);
});

test("first coach gets the site setup; lesson locations; spam limits", async () => {
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries, payment_proofs RESTART IDENTITY CASCADE`);
  const coach = ok(await call("POST", "/api/coach/signup", { name: "Simmons Performance Coaching", email: "connor@example.com", slug: "simmons", password: "longpassword1" }), 201).token;
  const pub = ok(await call("GET", "/api/c/simmons"));
  assert.equal(pub.coach.personName, "Connor Simmons");
  assert.equal(pub.coach.headline, "The best hour of your day");
  assert.equal(pub.coach.location, "Dallas, TX");
  assert.equal(pub.coach.payment.zelle, "4693076899");
  assert.equal(pub.coach.payment.cashapp, "$ConnorSimmons2022");
  assert.equal(pub.coach.contactEmail, "SimmonsMMA26@gmail.com");
  assert.doesNotMatch(pub.coach.bio + pub.coach.credentials, /amateur/i);
  assert.deepEqual(pub.packages.map((p) => p.name), ["12-Lesson Pack", "8-Lesson Pack", "Single Lesson", "Small Group Lesson"]);
  const dash = ok(await call("GET", "/api/coach/dashboard", null, coach));
  assert.equal(dash.availability.length, 6);

  // Buy, approve, then book: a location is required; in-home needs an address.
  ok(await call("PUT", "/api/coach/profile", { minNoticeHours: 0 }, coach));
  ok(await call("PUT", "/api/coach/availability", { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ weekday: d, startMin: 0, endMin: 1440 })) }, coach));
  const proof = "data:image/jpeg;base64," + Buffer.alloc(2000, 7).toString("base64");
  const ipA = { "x-nf-client-connection-ip": "203.0.113.5" };
  const r = ok(await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "Kai", email: "kai@example.com", proof }, null, ipA), 201);
  ok(await call("POST", `/api/coach/purchases/${r.purchaseId}/approve`, {}, coach));
  const slot = new Date(Math.ceil((Date.now() + 2 * 864e5) / 36e5) * 36e5).toISOString();
  assert.match((await call("POST", "/api/c/simmons/lessons", { startsAt: slot }, r.token)).body.error, /where/);
  assert.match((await call("POST", "/api/c/simmons/lessons", { startsAt: slot, location: "Somewhere else" }, r.token)).body.error, /training locations/);
  assert.match((await call("POST", "/api/c/simmons/lessons", { startsAt: slot, location: "In-home training: 1200 Main St" }, r.token)).body.error, /arranged directly/);
  const l = ok(await call("POST", "/api/c/simmons/lessons", { startsAt: slot, location: "Iron MMA" }, r.token), 201).lesson;
  assert.equal(l.location, "Iron MMA");
  const me = ok(await call("GET", "/api/c/simmons/me", null, r.token));
  assert.equal(me.lessons[0].location, "Iron MMA");
  // The coach can still book in-home with an address.
  const [cl] = await q(`SELECT id FROM clients WHERE email = 'kai@example.com'`);
  ok(await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "Kai", email: "kai@example.com", proof }, r.token, { "x-nf-client-connection-ip": "192.0.2.9" }), 201);
  const [pend] = await q(`SELECT id FROM purchases WHERE status = 'pending' ORDER BY id DESC LIMIT 1`);
  ok(await call("POST", `/api/coach/purchases/${pend.id}/approve`, {}, coach));
  const later = new Date(Math.ceil((Date.now() + 3 * 864e5) / 36e5) * 36e5).toISOString();
  assert.equal(ok(await call("POST", "/api/coach/lessons", { clientId: cl.id, startsAt: later, location: "In-home training: 1200 Main St, Dallas" }, coach), 201).lesson.location, "In-home training: 1200 Main St, Dallas");

  // Spam: honeypot refused; 5 submissions per sender per day.
  assert.equal((await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "Bot", email: "bot@example.com", proof, website: "x" }, null, ipA)).status, 400);
  for (let i = 0; i < 4; i++) ok(await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "S" + i, email: `s${i}@example.com`, proof }, null, ipA), 201);
  assert.equal((await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "S9", email: "s9@example.com", proof }, null, ipA)).status, 429);
  ok(await call("POST", "/api/c/simmons/manual-purchase", { phone: "4695550100", packageId: pub.packages[2].id, method: "zelle", name: "Other", email: "o@example.com", proof }, null, { "x-nf-client-connection-ip": "198.51.100.7" }), 201);
});

test("phone number is required to sign up, buy and request a quote", async () => {
  await q(`TRUNCATE coaches, clients, sessions, packages, purchases, availability, time_off, lessons, releases, inquiries, payment_proofs RESTART IDENTITY CASCADE`);
  ok(await call("POST", "/api/coach/signup", { name: "SPC", email: "c@example.com", slug: "spc", password: "longpassword1" }), 201);
  const pkg = ok(await call("GET", "/api/c/spc")).packages[0];
  const proof = "data:image/jpeg;base64," + Buffer.alloc(2000, 7).toString("base64");
  assert.match((await call("POST", "/api/c/spc/signup", { name: "A", email: "a@example.com", password: "password12" })).body.error, /phone/);
  assert.match((await call("POST", "/api/c/spc/manual-purchase", { packageId: pkg.id, method: "zelle", name: "A", email: "a@example.com", proof, phone: "123" })).body.error, /phone/);
  assert.match((await call("POST", "/api/c/spc/inquiries", { name: "A", email: "a@example.com" })).body.error, /phone/);
  ok(await call("POST", "/api/c/spc/manual-purchase", { packageId: pkg.id, method: "zelle", name: "A", email: "a@example.com", proof, phone: "(469) 555-0100" }), 201);
});
