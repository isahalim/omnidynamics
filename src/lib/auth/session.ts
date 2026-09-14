/**
 * The signed-in person, for the browser.
 *
 * ## The protocol
 *
 * OpenID Connect, and only the identity half of it. Google Identity Services
 * hands the page a single artefact — an **id token**: a JWT that Google has
 * signed, saying who this person is, which site they signed in to, and when the
 * statement expires. There is no access token, no refresh token, no scope
 * beyond the name and address in the token itself, and nothing that can be
 * exchanged for access to anything at Google. The site is told who you are and
 * given no power to act as you, which is the whole of what it needs.
 *
 * That shape is what lets this work with no server. The authorization code flow
 * would be the stronger protocol, but completing it means calling Google's
 * token endpoint with a client secret, and a site served as static files has
 * nowhere to keep one — writing it into the bundle would simply publish it.
 * Google's answer for a page in that position is this: no code, no exchange, no
 * secret, just a signed assertion delivered to the browser.
 *
 * ## Why the signature is checked here
 *
 * A token nobody verifies is a string an attacker can write. There is no server
 * to check it, so the check happens here: the signature against Google's
 * published keys, the issuer, the audience, the nonce this page generated, and
 * the expiry. {@link verify} does all five, and a token that fails any of them
 * is discarded without a person being shown.
 *
 * This is not a claim that the browser is trustworthy — code already running on
 * this origin can do as it likes, and verification cannot change that. It is
 * the guarantee that a credential arriving from *outside* this page, out of
 * storage or another frame, is Google's and is for us. That is the threat this
 * removes, and it is worth removing.
 *
 * ## Where the token lives
 *
 * In `sessionStorage`, for the life of the tab, and re-verified every time it
 * is read back. Closing the tab discards it; a token that expires is dropped on
 * the spot by a timer rather than left to be noticed later.
 *
 * The old version of this file kept tokens in a closure and refused storage
 * entirely, because what it was holding was an OAuth *refresh* token — a
 * long-lived credential that, stolen, outlives the theft and keeps working. An
 * id token is not that. It cannot be redeemed for anything, it names this site
 * as its only audience, and it is void within the hour. `sessionStorage` is the
 * right home for it: per-tab, per-origin, and gone when the tab is.
 *
 * The cost is that it is per-*tab*. Opening a link in a new tab starts signed
 * out, and the sign-in page offers Google's One Tap to pick the session back up
 * in one click rather than a full sign-in.
 *
 * ## Separation
 *
 * Identity is `issuer + subject`, never `sub` alone — `sub` is only unique
 * within an issuer, so keying anything on it is a collision waiting for a
 * second provider. Everything this site caches for a person is filed under that
 * pair by {@link scopedStorage}, and anything filed under a different one is
 * deleted the moment someone else signs in on the same browser. Authorization
 * is not done here at all: claims decide what the interface offers, and any API
 * that ever holds data must check the token itself. A UI that hides a button
 * has not protected anything.
 */
import { GOOGLE, GOOGLE_ISSUERS, SIGN_IN_READY } from "./config";

/* ── What Google Identity Services gives us ───────────────────────────────── */

interface CredentialResponse {
  readonly credential: string;
  readonly select_by?: string;
}

interface ButtonOptions {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
  locale?: string;
}

interface GoogleIdentity {
  initialize(config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    nonce?: string;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    context?: "signin" | "signup" | "use";
    itp_support?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(parent: HTMLElement, options: ButtonOptions): void;
  prompt(listener?: (notification: unknown) => void): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdentity } };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";

/** Where the credential and the nonce it was issued against are kept. */
const CREDENTIAL = "od.credential";
const NONCE = "od.nonce";

/** What a page is given about the person in front of it. */
export interface Account {
  /** `issuer|subject` — the only globally unique name a person has here. */
  readonly id: string;
  readonly issuer: string;
  readonly subject: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly picture: string;
  /** The Workspace domain, where there is one. Whose organisation this is. */
  readonly organisation: string;
  /** Seconds of identity token left, for the account page to show honestly. */
  readonly expiresIn: number;
  /** Every claim held, so `/account/` can show the lot rather than a summary. */
  readonly claims: Readonly<Record<string, unknown>>;
}

/* ── Loading the library ──────────────────────────────────────────────────── */

let loading: Promise<GoogleIdentity> | null = null;

/**
 * Fetches Google's script once and resolves with the interface it defines.
 *
 * It is loaded on demand rather than from the head of every page: on a build
 * with no client id it is never fetched at all, and on the others it arrives
 * after the page the reader actually came for.
 */
function library(): Promise<GoogleIdentity> {
  if (loading) return loading;

  loading = new Promise<GoogleIdentity>((resolve, reject) => {
    const ready = () => {
      const id = window.google?.accounts?.id;
      if (id) resolve(id);
      else reject(new Error("Google Identity Services loaded without an id client"));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      if (window.google?.accounts?.id) ready();
      else existing.addEventListener("load", ready, { once: true });
      existing.addEventListener("error", () => reject(new Error("could not load Google Identity Services")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", ready, { once: true });
    script.addEventListener("error", () => reject(new Error("could not load Google Identity Services")), { once: true });
    document.head.append(script);
  });

  loading.catch(() => {
    // A failed load must not be cached as a permanent verdict: a reader on a
    // flaky connection who presses the button again deserves a second attempt.
    loading = null;
  });
  return loading;
}

let started: Promise<GoogleIdentity> | null = null;

/**
 * Configures the client, once.
 *
 * The nonce is generated here and kept beside the credential, so a token can be
 * checked against the request that asked for it even after a reload — a token
 * minted for some other page, or replayed from somewhere else, does not carry
 * this tab's nonce and is refused.
 */
function start(): Promise<GoogleIdentity> {
  if (started) return started;
  started = library().then((id) => {
    id.initialize({
      client_id: GOOGLE.clientId,
      callback: (response) => void accept(response.credential),
      nonce: nonce(),
      // Returning readers get One Tap's one-click path rather than the account
      // chooser; it is never automatic enough to sign anyone in unasked.
      auto_select: true,
      cancel_on_tap_outside: true,
      context: "signin",
      itp_support: true,
      use_fedcm_for_prompt: true,
    });
    return id;
  });
  return started;
}

/** This tab's nonce, made once and remembered for as long as the tab lives. */
function nonce(): string {
  const held = window.sessionStorage.getItem(NONCE);
  if (held) return held;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const made = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  window.sessionStorage.setItem(NONCE, made);
  return made;
}

/* ── Verifying what comes back ────────────────────────────────────────────── */

const decode = (segment: string) => {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const text = new TextDecoder();

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

let keys: Map<string, CryptoKey> | null = null;

/**
 * Google's signing keys, by key id.
 *
 * They rotate, so a `kid` that is not in the cached set is a reason to fetch
 * the set again rather than to reject the token — but only once, so a token
 * naming a key that does not exist cannot make this page hammer the endpoint.
 */
async function signingKey(kid: string): Promise<CryptoKey | null> {
  if (keys?.has(kid)) return keys.get(kid)!;

  const response = await fetch(JWKS_URL, { credentials: "omit" });
  if (!response.ok) throw new Error(`could not fetch Google's signing keys: ${response.status}`);
  const { keys: published } = (await response.json()) as { keys: Jwk[] };

  const fresh = new Map<string, CryptoKey>();
  for (const jwk of published) {
    if (jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) continue;
    fresh.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      )
    );
  }
  keys = fresh;
  return fresh.get(kid) ?? null;
}

/**
 * The claims of a token that is Google's, is for us, is for this tab, and has
 * not expired — or null, for a token that is any of those things and no person
 * should be shown for.
 */
async function verify(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(text.decode(decode(rawHeader)));
    claims = JSON.parse(text.decode(decode(rawPayload)));
  } catch {
    return null;
  }

  // RS256 only. An `alg` of `none`, or a symmetric algorithm keyed on something
  // the token itself supplies, is the classic way a JWT check is walked past.
  if (header.alg !== "RS256" || !header.kid) return null;

  const key = await signingKey(header.kid);
  if (!key) return null;

  const signed = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    decode(rawSignature),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!signed) return null;

  const claim = (name: string) => {
    const value = claims[name];
    return typeof value === "string" ? value : "";
  };

  if (!(GOOGLE_ISSUERS as readonly string[]).includes(claim("iss"))) return null;
  // The audience is what stops a perfectly valid Google token, issued to some
  // other site, from signing its holder in here.
  if (claim("aud") !== GOOGLE.clientId) return null;
  if (claim("nonce") !== nonce()) return null;
  if (!claim("sub")) return null;

  const expires = typeof claims.exp === "number" ? claims.exp : 0;
  if (!expires || expires * 1000 <= Date.now()) return null;

  return claims;
}

/** Reads the claims this site cares about off a verified token. */
function read(claims: Record<string, unknown>): Account {
  const claim = (name: string) => {
    const value = claims[name];
    return typeof value === "string" ? value : "";
  };
  const issuer = claim("iss");
  const subject = claim("sub");
  const email = claim("email");
  const expires = typeof claims.exp === "number" ? claims.exp : 0;

  return {
    id: `${issuer}|${subject}`,
    issuer,
    subject,
    email,
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    // A person who gave a name is called by it; otherwise the address they
    // signed in with, and never a bare `sub` — that is a database key.
    name: claim("name") || claim("given_name") || email,
    picture: claim("picture"),
    organisation: claim("hd"),
    expiresIn: Math.max(0, Math.round(expires - Date.now() / 1000)),
    claims,
  };
}

/* ── Who is signed in ─────────────────────────────────────────────────────── */

type Watcher = (account: Account | null) => void;
const watchers = new Set<Watcher>();
let latest: Account | null = null;
let expiry: number | undefined;

function announce(account: Account | null) {
  // One person's cached work must not be sitting there for the next one.
  partition(account?.id ?? null);
  latest = account;
  for (const watcher of watchers) watcher(account);

  window.clearTimeout(expiry);
  if (account) {
    // The statement has a stated lifetime and this honours it: when it runs
    // out the person is signed out here, rather than the page going on showing
    // a name backed by nothing.
    expiry = window.setTimeout(() => forget(), account.expiresIn * 1000);
  }
}

/**
 * Watches who is signed in. Fires immediately with what is known now — which
 * on a fresh page is `null` until {@link restore} has read the tab's token —
 * and again on every change. Returns the unsubscribe.
 */
export function observe(watcher: Watcher): () => void {
  watchers.add(watcher);
  watcher(latest);
  return () => watchers.delete(watcher);
}

/** Who is signed in, as of the last thing that happened. */
export function current(): Account | null {
  return latest;
}

/** Takes a credential from Google, checks it, and keeps it if it holds up. */
async function accept(credential: string): Promise<Account | null> {
  const claims = await verify(credential);
  if (!claims) {
    console.warn("a sign-in credential did not verify and was discarded");
    forget();
    return null;
  }
  window.sessionStorage.setItem(CREDENTIAL, credential);
  announce(read(claims));
  return latest;
}

/** Drops the session in this tab. Google's own session is untouched. */
function forget() {
  window.sessionStorage.removeItem(CREDENTIAL);
  announce(null);
}

/**
 * Picks the session back up on a page load: the tab's token, verified again
 * from scratch, or nothing. No network call and no interface — a reader who is
 * signed out is simply signed out, and is never interrupted to be told so.
 */
export async function restore(): Promise<Account | null> {
  if (!SIGN_IN_READY || typeof window === "undefined") return null;
  const held = window.sessionStorage.getItem(CREDENTIAL);
  if (!held) return null;

  try {
    const claims = await verify(held);
    if (!claims) {
      forget();
      return null;
    }
    announce(read(claims));
    return latest;
  } catch (error) {
    // Google's keys were unreachable, so the token cannot be checked. An
    // unchecked token is not a person: say signed out and mean it.
    console.warn("could not verify the held credential", error);
    forget();
    return null;
  }
}

/**
 * Puts Google's own button in a container.
 *
 * It is Google's button, drawn by Google in a frame this page cannot reach
 * into, and that is the point: the one control on the site that asks a person
 * to trust who they are talking to should be the one the browser and Google
 * vouch for, not a convincing copy of it. The frame around it is ours.
 */
export async function mountSignIn(container: HTMLElement, options: ButtonOptions = {}) {
  if (!SIGN_IN_READY) throw new Error("no sign-in is configured");
  const id = await start();
  id.renderButton(container, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "center",
    ...options,
  });
}

/**
 * Offers One Tap: the one-click way back in for someone Google already knows,
 * and nothing at all for someone it does not. Only the sign-in page calls it —
 * a prompt that appears over a page a reader came to read is an interruption,
 * not a convenience.
 */
export async function offerOneTap() {
  if (!SIGN_IN_READY || latest) return;
  const id = await start();
  id.prompt();
}

/**
 * Ends the session here, and stops Google offering to resume it automatically.
 *
 * It cannot and should not sign anyone out of Google itself: this site was told
 * who someone is, it was never given the account, and reaching across to end a
 * session it does not own would be overreach. The account page says so.
 */
export async function signOut() {
  forget();
  if (!SIGN_IN_READY) return;
  try {
    const id = await start();
    id.disableAutoSelect();
  } catch (error) {
    // The library is unreachable, which changes nothing that matters: the
    // token is already gone from this tab.
    console.warn("could not reach Google Identity Services on sign-out", error);
  }
}

/* ── Per-person storage ───────────────────────────────────────────────────── */

const SCOPE = "od.acct.";
/**
 * A key prefix for one identity. The trailing dot is what makes the prefix
 * unambiguous — without it, one identity's bucket could be the start of
 * another's — and the escaping keeps a subject with a colon or a slash in it
 * from looking like the separator.
 */
const bucket = (id: string) => `${SCOPE}${encodeURIComponent(id)}.`;

/** Drops everything cached for anyone who is not the person now signed in. */
function partition(id: string | null) {
  if (typeof window === "undefined") return;
  const keep = id ? bucket(id) : "";
  const store = window.sessionStorage;
  for (const key of Object.keys(store)) {
    if (key.startsWith(SCOPE) && !(keep && key.startsWith(keep))) {
      store.removeItem(key);
    }
  }
}

export interface ScopedStorage {
  get(name: string): string | null;
  set(name: string, value: string): void;
  remove(name: string): void;
  /** Everything this person has cached here, gone. */
  clear(): void;
}

/**
 * Storage filed under the signed-in person, and null when nobody is — so there
 * is no way to write something on a person's behalf that is not attributed to
 * them, and nothing survives into the next person's session by accident. It is
 * a cache and only a cache: it is `sessionStorage`, it is readable by this
 * origin, and nothing belongs in it that the account itself does not already
 * disclose.
 */
export function scopedStorage(): ScopedStorage | null {
  const id = latest?.id;
  if (!id || typeof window === "undefined") return null;
  const prefix = bucket(id);
  const store = window.sessionStorage;
  return {
    get: (name) => store.getItem(prefix + name),
    set: (name, value) => store.setItem(prefix + name, value),
    remove: (name) => store.removeItem(prefix + name),
    clear: () => {
      for (const key of Object.keys(store)) {
        if (key.startsWith(prefix)) store.removeItem(key);
      }
    },
  };
}
