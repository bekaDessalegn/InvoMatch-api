import Stripe from "stripe";

import { env } from "../config/env";
import { supabase } from "../db/supabase";
import { ApiError } from "../middleware/errorHandler";
import {
  type PlanId,
  type TopupId,
  PLANS,
  TOPUPS,
  grantTopup,
  isPlanId,
  isTopupId,
  loadStore,
  markCanceled,
  markSubscribed,
  replacePlanScans,
} from "./billing";

export function stripeReady(): boolean {
  return Boolean(
    env.stripeSecretKey &&
      env.stripeWebhookSecret &&
      env.stripePriceStarter &&
      env.stripePriceStandard &&
      env.stripePricePlus &&
      env.stripePriceScan1 &&
      env.stripePriceScan5 &&
      env.stripePriceScan10,
  );
}

function priceIdForPlan(plan: PlanId): string {
  const id = {
    starter: env.stripePriceStarter,
    standard: env.stripePriceStandard,
    plus: env.stripePricePlus,
  }[plan];
  if (!id) throw new ApiError(503, "Stripe prices are not configured yet.");
  return id;
}

function priceIdForTopup(topup: TopupId): string {
  const id = {
    scan_1: env.stripePriceScan1,
    scan_5: env.stripePriceScan5,
    scan_10: env.stripePriceScan10,
  }[topup];
  if (!id) throw new ApiError(503, "Stripe prices are not configured yet.");
  return id;
}

function planForPrice(priceId: string): PlanId | null {
  if (priceId === env.stripePriceStarter) return "starter";
  if (priceId === env.stripePriceStandard) return "standard";
  if (priceId === env.stripePricePlus) return "plus";
  return null;
}

function stripeClient(): Stripe {
  if (!env.stripeSecretKey) throw new ApiError(503, "Stripe is not configured yet.");
  return new Stripe(env.stripeSecretKey);
}

let listedPriceCache: { at: number; amounts: Partial<Record<PlanId | TopupId, number>> } | null = null;
let warnedAboutPublishableKey = false;

/** Amounts charged by the price IDs in the environment, in cents. */
async function listedAmounts(): Promise<Partial<Record<PlanId | TopupId, number>> | null> {
  const key = env.stripeSecretKey;
  if (!key.startsWith("sk_") && !key.startsWith("rk_")) {
    if (key && !warnedAboutPublishableKey) {
      warnedAboutPublishableKey = true;
      console.error(
        "STRIPE_SECRET_KEY is a publishable key. Plan prices in the app stay at the built-in amounts until this is the secret key (sk_live_...).",
      );
    }
    return null;
  }
  if (listedPriceCache && Date.now() - listedPriceCache.at < 60_000) return listedPriceCache.amounts;

  const ids: Array<[PlanId | TopupId, string]> = [
    ["starter", env.stripePriceStarter],
    ["standard", env.stripePriceStandard],
    ["plus", env.stripePricePlus],
    ["scan_1", env.stripePriceScan1],
    ["scan_5", env.stripePriceScan5],
    ["scan_10", env.stripePriceScan10],
  ];

  try {
    const stripe = stripeClient();
    const amounts: Partial<Record<PlanId | TopupId, number>> = {};
    await Promise.all(
      ids.map(async ([name, id]) => {
        if (!id) return;
        const price = await stripe.prices.retrieve(id);
        if (typeof price.unit_amount === "number") amounts[name] = price.unit_amount;
      }),
    );
    listedPriceCache = { at: Date.now(), amounts };
    return amounts;
  } catch (error) {
    console.error("Could not load Stripe prices", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Replace the built-in dollar amounts with the amounts on the live Stripe prices. */
export async function applyListedPrices<T extends { plans: typeof PLANS; topups: typeof TOPUPS }>(
  snapshot: T,
): Promise<T> {
  const amounts = await listedAmounts();
  if (!amounts) return snapshot;
  return {
    ...snapshot,
    plans: {
      starter: { ...snapshot.plans.starter, amountCents: amounts.starter ?? snapshot.plans.starter.amountCents },
      standard: { ...snapshot.plans.standard, amountCents: amounts.standard ?? snapshot.plans.standard.amountCents },
      plus: { ...snapshot.plans.plus, amountCents: amounts.plus ?? snapshot.plans.plus.amountCents },
    },
    topups: {
      scan_1: { ...snapshot.topups.scan_1, amountCents: amounts.scan_1 ?? snapshot.topups.scan_1.amountCents },
      scan_5: { ...snapshot.topups.scan_5, amountCents: amounts.scan_5 ?? snapshot.topups.scan_5.amountCents },
      scan_10: { ...snapshot.topups.scan_10, amountCents: amounts.scan_10 ?? snapshot.topups.scan_10.amountCents },
    },
  };
}

export async function createCheckout(input: {
  storeId: string;
  email: string | undefined;
  plan?: PlanId;
  topup?: TopupId;
}): Promise<string> {
  const stripe = await stripeClient();
  const store = await loadStore(input.storeId);
  const returnBase = env.publicBaseUrl.replace(/\/$/, "");

  if (input.plan) {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: store.stripe_customer_id ?? undefined,
      customer_email: store.stripe_customer_id ? undefined : input.email,
      line_items: [{ price: priceIdForPlan(input.plan), quantity: 1 }],
      success_url: `${returnBase}/billing/return?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBase}/billing/return?status=cancel`,
      client_reference_id: input.storeId,
      metadata: { store_id: input.storeId, plan: input.plan },
      subscription_data: { metadata: { store_id: input.storeId, plan: input.plan } },
    });
    if (!session.url) throw new ApiError(500, "Stripe did not return a checkout link.");
    return session.url;
  }

  if (!input.topup) throw new ApiError(400, "Choose a plan or a scan pack.");
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: store.stripe_customer_id ?? undefined,
    customer_email: store.stripe_customer_id ? undefined : input.email,
    line_items: [{ price: priceIdForTopup(input.topup), quantity: 1 }],
      success_url: `${returnBase}/billing/return?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnBase}/billing/return?status=cancel`,
      client_reference_id: input.storeId,
      metadata: {
      store_id: input.storeId,
      topup: input.topup,
      scans: String(TOPUPS[input.topup].scans),
    },
  });
  if (!session.url) throw new ApiError(500, "Stripe did not return a checkout link.");
  return session.url;
}

export async function createPortal(storeId: string): Promise<string> {
  const stripe = await stripeClient();
  const store = await loadStore(storeId);
  if (!store.stripe_customer_id) throw new ApiError(400, "This store has not subscribed yet.");
  const session = await stripe.billingPortal.sessions.create({
    customer: store.stripe_customer_id,
    return_url: `${env.publicBaseUrl.replace(/\/$/, "")}/billing/return?status=portal`,
  });
  return session.url;
}

export async function fulfillCheckoutSession(sessionId: string): Promise<void> {
  if (!env.stripeSecretKey) return;
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== "paid" && session.status !== "complete") return;
  await applyCheckoutSession(stripe, session);
}

async function applyCheckoutSession(stripe: ReturnType<typeof stripeClient>, session: {
  id: string;
  mode: string | null;
  metadata: Record<string, string> | null;
  client_reference_id: string | null;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
}): Promise<void> {
  const storeId = session.metadata?.store_id ?? session.client_reference_id;
  if (!storeId) return;

  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
  const plan = session.metadata?.plan;
  const topup = session.metadata?.topup;

  if (session.mode === "subscription" && plan && isPlanId(plan)) {
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
    await markSubscribed({ storeId, plan, customerId, subscriptionId });
    const periodEnd = subscriptionId ? periodEndOf(await stripe.subscriptions.retrieve(subscriptionId)) : null;
    await replacePlanScans(storeId, plan, periodEnd, session.id);
    return;
  }

  if (session.mode === "payment" && topup && isTopupId(topup)) {
    if (customerId) await markCustomer(storeId, customerId);
    await grantTopup(storeId, topup, session.id);
  }
}

export async function handleStripeEvent(rawBody: Buffer, signature: string | undefined): Promise<void> {
  if (!env.stripeSecretKey || !env.stripeWebhookSecret) {
    throw new ApiError(503, "Stripe webhooks are not configured yet.");
  }
  if (!signature) throw new ApiError(400, "Missing Stripe signature.");

  const stripe = stripeClient();
  const event = stripe.webhooks.constructEvent(rawBody, signature, env.stripeWebhookSecret);

  if (event.type === "checkout.session.completed") {
    await applyCheckoutSession(stripe, event.data.object);
    return;
  }

  if (event.type === "invoice.paid") {
    const invoice = event.data.object;
    if (invoice.billing_reason !== "subscription_cycle") return;
    const subscriptionId = subscriptionIdFromInvoice(invoice);
    if (!subscriptionId) return;
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const storeId = subscription.metadata?.store_id;
    const priceId = subscription.items.data[0]?.price.id;
    const plan =
      (priceId ? planForPrice(priceId) : null) ??
      (subscription.metadata?.plan && isPlanId(subscription.metadata.plan) ? subscription.metadata.plan : null);
    if (!storeId || !plan) return;
    await markSubscribed({
      storeId,
      plan,
      customerId: typeof subscription.customer === "string" ? subscription.customer : null,
      subscriptionId,
    });
    await replacePlanScans(storeId, plan, periodEndOf(subscription), invoice.id);
    return;
  }

  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object;
    const previous = event.data.previous_attributes as { items?: unknown } | undefined;
    if (!previous?.items) return;
    const storeId = subscription.metadata?.store_id;
    const priceId = subscription.items.data[0]?.price.id;
    const plan =
      (priceId ? planForPrice(priceId) : null) ??
      (subscription.metadata?.plan && isPlanId(subscription.metadata.plan) ? subscription.metadata.plan : null);
    if (!storeId || !plan || subscription.status !== "active") return;
    const periodEnd = periodEndOf(subscription);
    await markSubscribed({
      storeId,
      plan,
      customerId: typeof subscription.customer === "string" ? subscription.customer : null,
      subscriptionId: subscription.id,
    });
    await replacePlanScans(storeId, plan, periodEnd, `${subscription.id}:${plan}:${periodEnd ?? "open"}`);
    return;
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const storeId = subscription.metadata?.store_id;
    if (storeId) await markCanceled(storeId);
  }
}

function periodEndOf(subscription: {
  items: { data: Array<{ current_period_end?: number }> };
  current_period_end?: number;
}): string | null {
  const end = subscription.items.data[0]?.current_period_end ?? subscription.current_period_end;
  return end ? new Date(end * 1000).toISOString() : null;
}

function subscriptionIdFromInvoice(invoice: {
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
}): string | null {
  const legacy = invoice.subscription;
  if (typeof legacy === "string") return legacy;
  if (legacy && typeof legacy === "object") return legacy.id;
  const parent = invoice.parent?.subscription_details?.subscription;
  if (typeof parent === "string") return parent;
  if (parent && typeof parent === "object") return parent.id;
  return null;
}

async function markCustomer(storeId: string, customerId: string): Promise<void> {
  await supabase.from("stores").update({ stripe_customer_id: customerId }).eq("id", storeId);
}
