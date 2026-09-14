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
 *
 * The provider on the other end is authentik, self-hosted, and the whole of it
 * is declared in `infra/authentik/` — which is the point: the names below are
 * matched by a blueprint in that directory rather than by someone remembering
 * what they clicked. Any certified OpenID provider would still work here; only
 * {@link FLOWS} is shaped by authentik in particular.
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
 * The provider, as a URL: its host to say out loud on the sign-in page, and its
 * origin to hang the flow deep-links below off. An issuer that is not a URL is
 * a misconfiguration, but it must not take the build down with it.
 */
const issuerUrl = (() => {
  try {
    return new URL(OIDC.issuer);
  } catch {
    return null;
  }
})();

export const ISSUER_HOST = issuerUrl?.host ?? OIDC.issuer;
export const ISSUER_ORIGIN = issuerUrl?.origin ?? "";

/**
 * The authentik flows that walk straight out to one federated identity.
 *
 * Google and a customer's SAML directory are federated *behind* authentik, not
 * integrated here: this site never sees a Google token or a SAML assertion, and
 * gets the same OIDC id token whichever way the person came in. What differs is
 * only which door they went through, and that is where authentik is unlike
 * Keycloak — an authorization request cannot name the upstream it wants, there
 * is no `kc_idp_hint`. What it has instead is flows, so each of these is the
 * slug of a flow whose one stage is a redirect to the matching source. The site
 * sends people to it with the authorization request as `next`; authentik holds
 * on to that and resumes it when the upstream returns.
 *
 * Blank is the honest default: no flow, no button. See
 * `infra/authentik/blueprints/omnidynamics.yaml`, which declares both ends.
 */
export const FLOWS = {
  google: read(import.meta.env.PUBLIC_OIDC_FLOW_GOOGLE),
  sso: read(import.meta.env.PUBLIC_OIDC_FLOW_SSO),
} as const;

/** A flow deep-link can only be built when the issuer parsed. */
export const flowReady = (flow: string) => Boolean(flow && ISSUER_ORIGIN);

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
