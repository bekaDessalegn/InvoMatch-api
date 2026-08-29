import Anthropic from "@anthropic-ai/sdk";

import { env } from "../config/env";

/**
 * Server-side Anthropic client. The Claude API key lives only here, in the
 * backend process — the Flutter app must never call Anthropic directly.
 *
 * Used by:
 *  - POST /invoices/parse   (invoice photo/PDF -> structured line items)
 *  - POST /deliveries/analyze (delivery photo -> detected item counts/matches)
 */
export const anthropic = new Anthropic({ apiKey: env.anthropicApiKey });

export const CLAUDE_MODEL = env.anthropicModel;
