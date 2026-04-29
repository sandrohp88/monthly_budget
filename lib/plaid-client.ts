import "server-only";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

let _client: PlaidApi | null = null;

export function getPlaidClient(): PlaidApi {
  if (_client) return _client;

  const env = process.env.PLAID_ENV ?? "sandbox";
  const basePath = PlaidEnvironments[env as keyof typeof PlaidEnvironments];
  if (!basePath) throw new Error(`Unknown PLAID_ENV: "${env}". Must be sandbox, development, or production.`);

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  if (!clientId || !secret) {
    throw new Error("PLAID_CLIENT_ID and PLAID_SECRET must be set in the environment.");
  }

  const cfg = new Configuration({
    basePath,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
      },
    },
  });

  _client = new PlaidApi(cfg);
  return _client;
}
