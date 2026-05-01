import { OAuthReturnClient } from "./oauth-return-client";

// Page Plaid sends the user's browser back to after the bank's OAuth handshake.
// The (app) layout already gates this with auth and runs migrations.
export default function PlaidOAuthReturnPage() {
  return <OAuthReturnClient />;
}
