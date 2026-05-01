// Shared key for stashing the Plaid link_token in localStorage so it survives
// the bank's OAuth redirect. Used by PlaidLinkButton (writer) and the
// /plaid/oauth-return page (reader).
export const PLAID_LINK_TOKEN_STORAGE_KEY = "finance_os.plaid_link_token";
