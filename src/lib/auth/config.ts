/**
 * Who the sign-in talks to, and where it lands when it comes back.
 *
 * This module is the only place that reads the environment, so both the pages
 * that render buttons and the script that performs the sign-in are looking at
 * one description of the deployment. It touches no browser API: the frontmatter
 * of an Astro page runs it at build time to decide whether a button exists at
 * all, and the client runs it again to perform the flow.
 *
 * Nothing in here is a secret. The site is served as static files, so anything
 * it knew, its readers would know — which is why the only credential it holds
 * is a client id, which is an identifier and not a password. There is no client
 * secret anywhere in this repository, and there is nowhere one could live: the
 * flow this site uses is the one Google designed for a page with no server
 * behind it. See `.env.example`, and the header of `session.ts`.
 */
import { BASE } from "../base";

const read = (value: string | undefined) => (value ?? "").trim();

/**
 * The OAuth client, from Google Cloud Console — an "OAuth client ID" of type
 * *Web application*, with this site's origins listed under Authorized
 * JavaScript origins. No redirect URI is involved: nothing redirects.
 */
export const GOOGLE = {
  clientId: read(import.meta.env.PUBLIC_GOOGLE_CLIENT_ID),
} as const;

/**
 * Whether sign-in is wired up at all. A build without a client id still ships
 * every page — the sign-in says plainly that it is not connected yet rather
 * than offering a button that fails the moment it is pressed.
 */
export const SIGN_IN_READY = Boolean(GOOGLE.clientId);

/**
 * Where a person actually authenticates, for saying so out loud on the pages
 * that ask them to. It is a constant rather than configuration because it is
 * Google's, not ours, and a deployment cannot move it.
 */
export const PROVIDER_HOST = "accounts.google.com";

/** The issuer Google signs its identity tokens as. Checked, not assumed. */
export const GOOGLE_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
] as const;

/**
 * The pages the site names. Written once here and prefixed with the build's
 * base path, so the same files serve from localhost, the apex domain and the
 * GitHub Pages mirror, whose paths carry the repository name.
 */
export const ROUTES = {
  home: `${BASE}/`,
  signIn: `${BASE}/signin/`,
  account: `${BASE}/account/`,
  terms: `${BASE}/terms/`,
  privacy: `${BASE}/privacy/`,
  book: `${BASE}/book/`,
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
