/**
 * Who the sign-in talks to, and where it lands when it comes back.
 *
 * This module is the only place that reads the environment, so both the pages
 * that render buttons and the script that performs the redirect are looking at
 * one description of the deployment. It touches no browser API: the frontmatter
 * of an Astro page runs it at build time to decide whether a button exists at
 * all, and the client runs it again to perform the flow.
 *
 * Nothing in here is a secret. The site is a public OAuth client — it is served
 * as static files, so anything it knew, its readers would know — which is why
 * the protocol it speaks is authorization code with PKCE and not one of the
 * flows that assumes a client can hold a password. See `.env.example`.
 */
import { BASE } from "../base";

const read = (value: string | undefined) => (value ?? "").trim();

/** The provider, as registered. `scope` is deliberately the minimum. */
export const OIDC = {
  issuer: read(import.meta.env.PUBLIC_OIDC_ISSUER),
  clientId: read(import.meta.env.PUBLIC_OIDC_CLIENT_ID),
  scope: read(import.meta.env.PUBLIC_OIDC_SCOPE) || "openid profile email",
} as const;

/**
 * Whether a provider is wired up at all. A build without one still ships every
 * page — the sign-in says plainly that it is not connected yet rather than
 * offering a button that fails on the far side of a redirect.
 */
export const OIDC_READY = Boolean(OIDC.issuer && OIDC.clientId);

/**
 * The provider's host, for saying out loud on the sign-in page where a person
 * is about to type their password. An issuer that is not a URL is a
 * misconfiguration, but it must not take the build down with it.
 */
export const ISSUER_HOST = (() => {
  try {
    return new URL(OIDC.issuer).host;
  } catch {
    return OIDC.issuer;
  }
})();

/**
 * Which upstream identity a button asks the provider to jump to.
 *
 * Google and a customer's SAML directory are federated behind the provider, not
 * integrated here: this site never sees a Google token or a SAML assertion, and
 * gets the same OIDC id token whichever way the person came in. The hint's
 * parameter name is provider-specific, so it is configuration rather than code.
 */
export const IDP = {
  param: read(import.meta.env.PUBLIC_OIDC_IDP_PARAM) || "kc_idp_hint",
  google: read(import.meta.env.PUBLIC_OIDC_IDP_GOOGLE),
  sso: read(import.meta.env.PUBLIC_OIDC_IDP_SSO),
} as const;

/**
 * The pages the protocol names. Every one of them is registered with the
 * provider as an exact string, so they are written once here and the
 * absolute form is built from the running origin — a build serves the same
 * files from localhost, the apex domain and the GitHub Pages mirror.
 */
export const ROUTES = {
  home: `${BASE}/`,
  signIn: `${BASE}/signin/`,
  account: `${BASE}/account/`,
  privacy: `${BASE}/privacy/`,
  book: `${BASE}/book/`,
  /** Where the provider returns a person after they sign in. */
  callback: `${BASE}/auth/callback/`,
  /** The hidden frame that renews a session without a visible redirect. */
  silent: `${BASE}/auth/silent/`,
} as const;

/**
 * Cal.com's hosted or self-hosted instance, and the event type to open.
 *
 * The booking link is the one public fact here that does not change between
 * deployments, so it is the default rather than something a build has to be
 * told. The environment still wins, which is what a self-hosted instance or a
 * second event type would use.
 */
export const CAL = {
  link: read(import.meta.env.PUBLIC_CAL_LINK) || "s-halim-0296y9/30min",
  origin: read(import.meta.env.PUBLIC_CAL_ORIGIN) || "https://cal.com",
} as const;

export const CAL_READY = Boolean(CAL.link);

/** Reachable however the rest of it is configured. */
export const EMAIL = "suzan@omnidynamics.dev";
