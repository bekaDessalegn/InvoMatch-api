import cors from "cors";
import express, { type Application } from "express";
import morgan from "morgan";

import { billingReturnPage } from "./controllers/billing.controller";
import { env } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { asyncHandler } from "./middleware/asyncHandler";
import { apiRouter } from "./routes";
import { handleStripeEvent } from "./services/stripeBilling";

export function createApp(): Application {
  const app = express();

  app.use(cors({ origin: env.corsOrigin }));

  // Stripe signs the raw body, so this route must run before JSON parsing.
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    asyncHandler(async (req, res) => {
      await handleStripeEvent(req.body as Buffer, req.headers["stripe-signature"] as string | undefined);
      res.json({ received: true });
    }),
  );
  app.get("/billing/return", asyncHandler(billingReturnPage));

  app.use(express.json({ limit: "2mb" }));
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "invomatch-server" });
  });

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
