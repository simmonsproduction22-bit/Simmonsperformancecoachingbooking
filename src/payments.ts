// Payment provider. Real mode uses Stripe Connect "separate charges and transfers":
//   1. The client pays the platform (Stripe Checkout). The money sits in the platform's Stripe balance.
//   2. Each time the coach marks a lesson done, the platform transfers that lesson's share to the
//      coach's connected account, which pays out to the coach's bank.
// The platform account's payout schedule MUST be set to manual, or Stripe sweeps the held money out.
//
// PAYMENTS_MODE=fake skips Stripe entirely (checkout succeeds instantly). For local testing and demos only.
import Stripe from "stripe";

export type CheckoutInput = {
  purchaseId: number; coachId: number; amountCents: number; name: string; description: string;
  email: string; successUrl: string; cancelUrl: string;
};
export type CheckoutResult = { paid: boolean; open: boolean; paymentIntent: string | null; chargeId: string | null };
export type WebhookEvent = { type: string; data: { object: any } };

export interface Payments {
  fake: boolean;
  createCheckout(i: CheckoutInput): Promise<{ id: string; url: string }>;
  getCheckout(id: string): Promise<CheckoutResult>;
  createConnectAccount(email: string, coachId: number): Promise<string>;
  onboardingLink(accountId: string, refreshUrl: string, returnUrl: string): Promise<string>;
  accountReady(accountId: string): Promise<boolean>;
  dashboardLink(accountId: string): Promise<string>;
  transfer(i: { amountCents: number; destination: string; chargeId: string | null; group: string; key: string; metadata: Record<string, string> }): Promise<string>;
  refund(i: { paymentIntent: string; amountCents: number; key: string }): Promise<string>;
  parseWebhook(rawBody: string, signature: string): Promise<WebhookEvent>;
}

function stripePayments(secretKey: string): Payments {
  const stripe = new Stripe(secretKey);
  return {
    fake: false,
    async createCheckout(i) {
      const s = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_email: i.email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "usd", unit_amount: i.amountCents,
            product_data: { name: i.name, ...(i.description ? { description: i.description.slice(0, 500) } : {}) },
          },
        }],
        payment_intent_data: {
          transfer_group: `purchase_${i.purchaseId}`,
          metadata: { purchase_id: String(i.purchaseId), coach_id: String(i.coachId) },
        },
        metadata: { purchase_id: String(i.purchaseId), coach_id: String(i.coachId) },
        success_url: i.successUrl,
        cancel_url: i.cancelUrl,
      }, { idempotencyKey: `checkout-${i.purchaseId}` });
      return { id: s.id, url: s.url! };
    },
    async getCheckout(id) {
      const s = await stripe.checkout.sessions.retrieve(id, { expand: ["payment_intent"] });
      const pi = s.payment_intent as Stripe.PaymentIntent | null;
      const charge = pi?.latest_charge;
      return {
        paid: s.payment_status === "paid",
        open: s.status === "open",
        paymentIntent: pi?.id ?? null,
        chargeId: typeof charge === "string" ? charge : charge?.id ?? null,
      };
    },
    async createConnectAccount(email, coachId) {
      const a = await stripe.accounts.create({
        type: "express", country: "US", email,
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: "daily" } } },
        metadata: { coach_id: String(coachId) },
      }, { idempotencyKey: `connect-${coachId}` });
      return a.id;
    },
    async onboardingLink(accountId, refreshUrl, returnUrl) {
      const l = await stripe.accountLinks.create({
        account: accountId, type: "account_onboarding", refresh_url: refreshUrl, return_url: returnUrl,
      });
      return l.url;
    },
    async accountReady(accountId) {
      const a = await stripe.accounts.retrieve(accountId);
      return Boolean(a.payouts_enabled) && a.capabilities?.transfers === "active";
    },
    async dashboardLink(accountId) {
      return (await stripe.accounts.createLoginLink(accountId)).url;
    },
    async transfer(i) {
      // source_transaction ties the transfer to the client's charge, so it works even before
      // that charge's funds have settled in the platform balance.
      const t = await stripe.transfers.create({
        amount: i.amountCents, currency: "usd", destination: i.destination,
        transfer_group: i.group, metadata: i.metadata,
        ...(i.chargeId ? { source_transaction: i.chargeId } : {}),
      }, { idempotencyKey: i.key });
      return t.id;
    },
    async refund(i) {
      const r = await stripe.refunds.create(
        { payment_intent: i.paymentIntent, amount: i.amountCents }, { idempotencyKey: i.key });
      return r.id;
    },
    async parseWebhook(rawBody, signature) {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
      return (await stripe.webhooks.constructEventAsync(rawBody, signature, secret)) as unknown as WebhookEvent;
    },
  };
}

function fakePayments(): Payments {
  const id = (p: string) => `${p}_fake_${Math.random().toString(36).slice(2, 10)}`;
  return {
    fake: true,
    async createCheckout(i) {
      const sid = `cs_fake_${i.purchaseId}`;
      return { id: sid, url: i.successUrl.replace("{CHECKOUT_SESSION_ID}", sid) };
    },
    async getCheckout(sid) {
      return { paid: true, open: false, paymentIntent: `pi_fake_${sid.slice(8)}`, chargeId: `ch_fake_${sid.slice(8)}` };
    },
    async createConnectAccount() { return id("acct"); },
    async onboardingLink(_a, _r, returnUrl) { return returnUrl; },
    async accountReady() { return true; },
    async dashboardLink() { return "https://dashboard.stripe.com/test"; },
    async transfer() { return id("tr"); },
    async refund() { return id("re"); },
    async parseWebhook(rawBody) { return JSON.parse(rawBody); },
  };
}

let instance: Payments | null = null;
export function payments(): Payments {
  if (instance) return instance;
  if (process.env.PAYMENTS_MODE === "fake") return (instance = fakePayments());
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Payments are not set up yet: STRIPE_SECRET_KEY is missing.");
  return (instance = stripePayments(key));
}

export function paymentsConfigured(): boolean {
  return process.env.PAYMENTS_MODE === "fake" || Boolean(process.env.STRIPE_SECRET_KEY);
}
