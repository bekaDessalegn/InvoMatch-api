import { Router } from "express";

import { adminRouter } from "./admin.routes";
import { billingRouter } from "./billing.routes";
import { deliveriesRouter } from "./deliveries.routes";
import { invitesRouter } from "./invites.routes";
import { invoicesRouter } from "./invoices.routes";
import { itemsRouter } from "./items.routes";
import { meRouter } from "./me.routes";
import { priceAlertsRouter } from "./priceAlerts.routes";
import { storesRouter } from "./stores.routes";
import { teamRouter } from "./team.routes";
import { vendorsRouter } from "./vendors.routes";

export const apiRouter = Router();

// Auth/onboarding — require a valid session but (deliberately) not yet a
// store membership, since /stores is how a new user creates their first one.
apiRouter.use("/me", meRouter);
apiRouter.use("/billing", billingRouter);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/stores", storesRouter);
apiRouter.use("/invites", invitesRouter);
apiRouter.use("/team", teamRouter);

// Store-scoped resource routers — each of these applies `authenticate` +
// `requireStore` internally before any resource logic runs.
apiRouter.use("/vendors", vendorsRouter);
apiRouter.use("/items", itemsRouter);
apiRouter.use("/invoices", invoicesRouter);
apiRouter.use("/deliveries", deliveriesRouter);
apiRouter.use("/price-alerts", priceAlertsRouter);
