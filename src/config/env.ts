import "dotenv/config";

/**
 * Centralized, validated access to environment variables. Import this
 * instead of reading `process.env` directly so missing configuration fails
 * fast and loudly at startup rather than deep inside a request handler.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value : fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: Number(optional("PORT", "4000")),

  supabaseUrl: required("SUPABASE_URL"),
  // The service-role key is required because the backend performs trusted,
  // server-side reads/writes on behalf of the app — never expose it to the
  // Flutter client.
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  anthropicModel: optional("ANTHROPIC_MODEL", "claude-sonnet-5"),

  corsOrigin: optional("CORS_ORIGIN", "*"),
};
