// The hold: card purchases stay on the platform and are released to the coach one lesson at a time.
import { q, tx, type Q } from "./db.ts";
import { payments } from "./payments.ts";

/** Statuses that consume a lesson credit. */
export const USES_CREDIT = ["booked", "completed", "no_show", "late_cancel"];
/** Statuses that mean the lesson was delivered (or forfeited) and its share is earned. */
export const RELEASES = ["completed", "no_show", "late_cancel"];

/** Per-lesson share of a package. The final lesson takes whatever rounding left over. */
export function lessonShare(amount: number, total: number, releasedCount: number, releasedSum: number): number {
  if (releasedCount >= total - 1) return Math.max(0, amount - releasedSum);
  return Math.floor(amount / total);
}

/**
 * Records the release for a lesson that was just closed as completed / no-show / late cancel.
 * Must run inside the transaction that changed the lesson. The Stripe transfer happens afterwards
 * in sendPendingReleases, so a Stripe outage never blocks marking a lesson.
 */
export async function recordLessonRelease(t: Q, lessonId: number): Promise<void> {
  const [lesson] = await t(`SELECT * FROM lessons WHERE id = $1`, [lessonId]);
  const [p] = await t(`SELECT * FROM purchases WHERE id = $1 FOR UPDATE`, [lesson.purchase_id]);
  if (!p || p.status !== "paid") return;
  const [{ n, sum }] = await t(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::int AS sum FROM releases WHERE purchase_id = $1`, [p.id]);
  const left = p.amount_cents - p.refunded_cents - sum;
  const share = Math.min(left, lessonShare(p.amount_cents, p.lessons_total, n, sum));
  if (share <= 0) return;
  const [coach] = await t(`SELECT platform_fee_bps FROM coaches WHERE id = $1`, [p.coach_id]);
  const fee = p.method === "card" ? Math.round((share * coach.platform_fee_bps) / 10_000) : 0;
  const inserted = await t(
    `INSERT INTO releases (coach_id, purchase_id, lesson_id, kind, amount_cents, fee_cents, status)
     VALUES ($1, $2, $3, 'lesson', $4, $5, $6) ON CONFLICT (lesson_id) DO NOTHING RETURNING id`,
    [p.coach_id, p.id, lessonId, share, fee, p.method === "card" ? "pending" : "not_held"]);
  if (inserted.length) {
    await t(`UPDATE purchases SET released_cents = released_cents + $2 WHERE id = $1`, [p.id, share]);
  }
}

/** Coach keeps the unused balance of an expired package. */
export async function recordForfeit(t: Q, purchaseId: number): Promise<number> {
  const [p] = await t(`SELECT * FROM purchases WHERE id = $1 FOR UPDATE`, [purchaseId]);
  const [{ booked }] = await t(
    `SELECT COUNT(*)::int AS booked FROM lessons WHERE purchase_id = $1 AND status = 'booked'`, [purchaseId]);
  if (booked > 0) throw new UserError("This package still has booked lessons. Close those out first.");
  const left = p.amount_cents - p.refunded_cents - p.released_cents;
  if (left <= 0) return 0;
  const fee = p.method === "card"
    ? Math.round((left * (await t(`SELECT platform_fee_bps FROM coaches WHERE id = $1`, [p.coach_id]))[0].platform_fee_bps) / 10_000)
    : 0;
  await t(
    `INSERT INTO releases (coach_id, purchase_id, kind, amount_cents, fee_cents, status)
     VALUES ($1, $2, 'forfeit', $3, $4, $5)`,
    [p.coach_id, p.id, left, fee, p.method === "card" ? "pending" : "not_held"]);
  await t(`UPDATE purchases SET released_cents = released_cents + $2 WHERE id = $1`, [p.id, left]);
  return left;
}

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/**
 * Sends every pending release for a coach to their Stripe account. Safe to call repeatedly:
 * each transfer uses the release id as its idempotency key.
 */
export async function sendPendingReleases(coachId: number): Promise<{ sent: number; failed: number; waiting: number }> {
  const [coach] = await q(`SELECT stripe_account_id, stripe_payouts_ready FROM coaches WHERE id = $1`, [coachId]);
  const pending = await q(
    `SELECT r.*, p.stripe_charge_id FROM releases r JOIN purchases p ON p.id = r.purchase_id
     WHERE r.coach_id = $1 AND r.status IN ('pending', 'failed') ORDER BY r.id`, [coachId]);
  if (!coach?.stripe_account_id || !coach.stripe_payouts_ready) {
    if (pending.length) {
      await q(`UPDATE releases SET error = 'Waiting for you to connect payouts.' WHERE coach_id = $1 AND status = 'pending'`, [coachId]);
    }
    return { sent: 0, failed: 0, waiting: pending.length };
  }
  let sent = 0, failed = 0;
  for (const r of pending) {
    const amount = r.amount_cents - r.fee_cents;
    if (amount <= 0) {
      await q(`UPDATE releases SET status = 'sent', sent_at = NOW(), error = '' WHERE id = $1`, [r.id]);
      continue;
    }
    try {
      const transferId = await payments().transfer({
        amountCents: amount, destination: coach.stripe_account_id, chargeId: r.stripe_charge_id,
        group: `purchase_${r.purchase_id}`, key: `release-${r.id}`,
        metadata: { release_id: String(r.id), purchase_id: String(r.purchase_id), lesson_id: String(r.lesson_id ?? "") },
      });
      await q(`UPDATE releases SET status = 'sent', stripe_transfer_id = $2, sent_at = NOW(), error = '' WHERE id = $1`, [r.id, transferId]);
      sent++;
    } catch (e: any) {
      await q(`UPDATE releases SET status = 'failed', error = $2 WHERE id = $1`, [r.id, String(e?.message ?? e).slice(0, 500)]);
      failed++;
    }
  }
  return { sent, failed, waiting: 0 };
}

/** Marks a purchase paid once Stripe confirms the checkout. Idempotent; used by both webhook and return page. */
export async function confirmPurchase(purchaseId: number): Promise<boolean> {
  const [p] = await q(`SELECT * FROM purchases WHERE id = $1`, [purchaseId]);
  if (!p) return false;
  if (p.status === "paid") return true;
  if (p.status !== "pending" || !p.stripe_session_id) return false;
  const c = await payments().getCheckout(p.stripe_session_id);
  if (!c.paid) {
    if (!c.open) await q(`UPDATE purchases SET status = 'canceled' WHERE id = $1 AND status = 'pending'`, [p.id]);
    return false;
  }
  return tx(async (t) => {
    const [row] = await t(`SELECT status FROM purchases WHERE id = $1 FOR UPDATE`, [p.id]);
    if (row.status === "paid") return true;
    const [pkg] = p.package_id ? await t(`SELECT expires_days FROM packages WHERE id = $1`, [p.package_id]) : [];
    const days = pkg?.expires_days ?? 90;
    await t(
      `UPDATE purchases SET status = 'paid', paid_at = NOW(), expires_at = NOW() + make_interval(days => $2),
         stripe_payment_intent = $3, stripe_charge_id = $4 WHERE id = $1`,
      [p.id, days, c.paymentIntent, c.chargeId]);
    return true;
  });
}

/** Lesson credits a client can still book, per purchase (oldest expiring first). */
export async function openCredits(t: Q, clientId: number) {
  return t(
    `SELECT p.id, p.package_name, p.package_kind, p.party_size, p.lessons_total, p.expires_at,
            p.lessons_total - COUNT(l.id) FILTER (WHERE l.status = ANY($2))::int AS remaining
     FROM purchases p LEFT JOIN lessons l ON l.purchase_id = p.id
     WHERE p.client_id = $1 AND p.status = 'paid' AND (p.expires_at IS NULL OR p.expires_at > NOW())
     GROUP BY p.id
     HAVING p.lessons_total - COUNT(l.id) FILTER (WHERE l.status = ANY($2)) > 0
     ORDER BY p.expires_at NULLS LAST, p.id`,
    [clientId, USES_CREDIT]);
}
