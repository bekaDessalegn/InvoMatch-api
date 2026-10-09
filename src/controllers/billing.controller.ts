import type { Request, Response } from "express";
import { z } from "zod";

import { ApiError } from "../middleware/errorHandler";
import { billingSnapshot, isPlanId, isTopupId } from "../services/billing";
import { applyListedPrices, createCheckout, createPortal, fulfillCheckoutSession, stripeReady } from "../services/stripeBilling";

const checkoutSchema = z.object({
  plan: z.enum(["starter", "standard", "plus"]).optional(),
  topup: z.enum(["scan_1", "scan_5", "scan_10"]).optional(),
});

/** GET /billing — plan, scan balances, and whether the paywall is on. */
export async function getBilling(req: Request, res: Response) {
  const snapshot = await applyListedPrices(await billingSnapshot(req.storeId!));
  res.json({ data: { ...snapshot, stripe_ready: stripeReady() } });
}

/** POST /billing/checkout — Stripe Checkout for a plan or a scan pack. */
export async function postCheckout(req: Request, res: Response) {
  if (req.storeRole !== "owner" && req.storeRole !== "admin") {
    throw new ApiError(403, "Only an owner or admin can change the plan.");
  }
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.plan && !parsed.data.topup)) {
    throw new ApiError(400, "Choose a plan or a scan pack.");
  }
  if (!stripeReady()) {
    throw new ApiError(503, "Card checkout is not set up yet.");
  }
  if (parsed.data.topup) {
    const snapshot = await billingSnapshot(req.storeId!);
    if (snapshot.status !== "active" || !snapshot.plan) {
      throw new ApiError(402, "Choose a plan before buying extra scans.", undefined, "subscription_required");
    }
  }

  const url = await createCheckout({
    storeId: req.storeId!,
    email: req.userEmail,
    plan: parsed.data.plan && isPlanId(parsed.data.plan) ? parsed.data.plan : undefined,
    topup: parsed.data.topup && isTopupId(parsed.data.topup) ? parsed.data.topup : undefined,
  });
  res.json({ data: { url } });
}

/** POST /billing/portal — Stripe page where the owner updates the card or cancels. */
export async function postPortal(req: Request, res: Response) {
  if (req.storeRole !== "owner" && req.storeRole !== "admin") {
    throw new ApiError(403, "Only an owner or admin can manage billing.");
  }
  if (!stripeReady()) throw new ApiError(503, "Card checkout is not set up yet.");
  const url = await createPortal(req.storeId!);
  res.json({ data: { url } });
}

export async function billingReturnPage(req: Request, res: Response) {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  if (sessionId) {
    try {
      await fulfillCheckoutSession(sessionId);
    } catch (error) {
      console.error("Could not apply the Stripe checkout", error);
    }
  }
  const status = req.query.status === "cancel" ? "cancelled" : "received";
  const title = status === "cancelled" ? "Checkout cancelled" : "You're all set";
  const body =
    status === "cancelled"
      ? "No charge was made. You can close this page and return to InvoMatch."
      : "The payment was received. You can close this page and return to InvoMatch. Pull to refresh if the new balance is not there yet.";
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f6f7fb; color: #14161f; }
    main { max-width: 420px; margin: 18vh auto; padding: 28px; background: white; border: 1px solid #e6e8f0; border-radius: 16px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { margin: 0; color: #6b7280; line-height: 1.5; }
  </style>
</head>
<body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`);
}
