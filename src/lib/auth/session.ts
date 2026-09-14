/**
 * The signed-in person, for the browser.
 *
 * ## The protocol
 *
 * Authorization code with PKCE, and nothing else. OAuth 2.1 removes the implicit
 * flow and the password grant and makes PKCE mandatory for every client, which
 * is exactly right for a site like this one: it is static files, so it cannot
 * keep a client secret, and the code verifier is the thing that proves the
 * browser that finishes the exchange is the browser that started it. The
 * protocol work is `oidc-client-ts` (Apache-2.0), a certified OpenID relying
 * party — it does discovery, S256 challenges, `state`, `nonce`, and id token
 * signature/issuer/audience/expiry validation. None of that is reimplemented
 * here, because a hand-rolled OAuth client is how sites get broken into.
 *
 * OIDC is what answers *who is signing in*: OAuth 2.0 on its own delegates
 * access to an API and says nothing about identity, and reading a person's
 * identity out of an access token is a well-known way to authenticate the wrong
 * person. The id token is the identity claim, and it is validated as one.
 *
 * ## Where the tokens live
 *
 * In memory, for the life of the tab, and nowhere else. Anything in
 * `localStorage` is readable by any script that ever manages to run on this
 * origin, and a stolen refresh token there outlives the theft; a token held in
 * a closure dies with the page. The cost is that a reload has no token, so the
 * session is restored by asking the provider — `prompt=none` in a hidden frame,
 * against the provider's own cookie, which is the copy of the session that is
 * allowed to be long-lived. The only things written to the tab's storage are
 * the PKCE verifier and `state` for the seconds a redirect is in flight, which
 * have to survive the navigation to be checked when it returns.
 *
 * (With a server in front of this site the better answer is a backend-for-
 * frontend holding the tokens in an `HttpOnly` cookie. There is no server here:
 * Cloudflare serves the built files and nothing else.)
 *
 * ## Separation
 *
 * Identity is `issuer + subject`, never `sub` alone — `sub` is only unique
 * within an issuer, so keying anything on it is a collision waiting for a
 * second provider. Everything this site caches for a person is filed under that
 * pair by {@link scopedStorage}, and anything filed under a different one is
 * deleted the moment someone else signs in on the same browser. Authorization
 * is not done here at all: claims decide what the interface offers, and the API
 * that holds the data checks the access token itself. A UI that hides a button
 * has not protected anything.
 */
import {
  UserManager,
  WebStorageStateStore,
  type StateStore,
  type User,
} from "oidc-client-ts";
import { IDP, OIDC, OIDC_READY, ROUTES } from "./config";

/** The user store: a Map, so tokens exist only while the page does. */
class MemoryStore implements StateStore {
  private readonly cells = new Map<string, string>();

  async set(key: string, value: string) {
    this.cells.set(key, value);
  }
  async get(key: string) {
    return this.cells.get(key) ?? null;
  }
  async remove(key: string) {
    const had = this.cells.get(key) ?? null;
    this.cells.delete(key);
    return had;
  }
  async getAllKeys() {
    return [...this.cells.keys()];
  }
}

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
  /** Tenant, where the provider issues one. Whose data this person is inside. */
  readonly organisation: string;
  /** What the provider agreed to, which may be less than what was asked for. */
  readonly scopes: readonly string[];
  /** Seconds of access token left, for the account page to show honestly. */
  readonly expiresIn: number;
  /** Every claim held, so `/account/` can show the lot rather than a summary. */
  readonly claims: Readonly<Record<string, unknown>>;
}

let manager: UserManager | null = null;

/** The absolute form of a route, as registered with the provider. */
const absolute = (path: string) => new URL(path, window.location.origin).href;

/**
 * The configured client, or null when this build has no provider. Built once,
 * lazily, and only in the browser: it reads `window.location` for the exact
 * redirect URIs, and there is nothing for it to do while the page is a string.
 */
export function client(): UserManager | null {
  if (!OIDC_READY || typeof window === "undefined") return null;
  if (manager) return manager;

  manager = new UserManager({
    authority: OIDC.issuer,
    client_id: OIDC.clientId,
    scope: OIDC.scope,

    redirect_uri: absolute(ROUTES.callback),
    silent_redirect_uri: absolute(ROUTES.silent),
    post_logout_redirect_uri: absolute(ROUTES.home),

    // OAuth 2.1, spelled out rather than left to a default: the code flow, with
    // PKCE, and no way for a redeploy to quietly turn either of them off.
    response_type: "code",
    response_mode: "query",
    disablePKCE: false,

    // Tokens in the tab; the redirect's proof-of-possession in the tab's
    // storage, where it can survive the navigation it has to be checked across.
    userStore: new MemoryStore(),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),

    // Renew before expiry so a long session never bounces mid-task, and hand
    // the tokens back to the provider on the way out instead of leaving them
    // valid until they age out.
    automaticSilentRenew: true,
    includeIdTokenInSilentRenew: true,
    validateSubOnSilentRenew: true,
    revokeTokensOnSignout: true,

    // The id token is the identity. Do not go back to the userinfo endpoint for
    // more of a person than was asked for at the door.
    loadUserInfo: false,
    // Session monitoring is a third-party iframe polling the provider on a
    // timer. Silent renew already notices a session that has ended.
    monitorSession: false,
  });

  // Sweep abandoned PKCE entries — a sign-in someone started and walked away
  // from leaves a verifier behind, and stale ones should not accumulate.
  void manager.clearStaleState();

  manager.events.addUserLoaded((user) => announce(read(user)));
  manager.events.addUserUnloaded(() => announce(null));
  manager.events.addSilentRenewError((error) => {
    // Not fatal on its own: the person is still signed in until the token they
    // hold expires. It is the reason a session ends without anyone clicking.
    console.warn("silent renew failed", error);
  });

  return manager;
}

/** Reads the claims this site cares about off a validated id token. */
function read(user: User): Account {
  const claims = user.profile as Record<string, unknown>;
  const text = (key: string) => {
    const value = claims[key];
    return typeof value === "string" ? value : "";
  };
  const issuer = text("iss");
  const subject = text("sub");
  const email = text("email");

  return {
    id: `${issuer}|${subject}`,
    issuer,
    subject,
    email,
    emailVerified: claims.email_verified === true,
    // A person who gave a name is called by it; otherwise the address they
    // signed in with, and never a bare `sub` — that is a database key.
    name: text("name") || text("preferred_username") || text("given_name") || email,
    picture: text("picture"),
    organisation: text("org_id") || text("organization") || text("tenant") || "",
    scopes: (user.scope ?? OIDC.scope).split(" ").filter(Boolean),
    expiresIn: user.expires_in ?? 0,
    claims,
  };
}

type Watcher = (account: Account | null) => void;
const watchers = new Set<Watcher>();
let latest: Account | null = null;

function announce(account: Account | null) {
  // One person's cached work must not be sitting there for the next one.
  partition(account?.id ?? null);
  latest = account;
  for (const watcher of watchers) watcher(account);
}

/**
 * Watches who is signed in. Fires immediately with what is known now — which
 * on a fresh page is `null` until {@link restore} has been round the provider —
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

/**
 * Picks the session back up on a page load. There is never a token in memory at
 * that point, so this is a `prompt=none` round trip to the provider in a hidden
 * frame: it returns a person if the provider still has a session for them, and
 * null — quietly, without a redirect — if it does not.
 */
export async function restore(): Promise<Account | null> {
  const oidc = client();
  if (!oidc) return null;

  const held = await oidc.getUser();
  if (held && !held.expired) {
    announce(read(held));
    return latest;
  }

  try {
    const user = await oidc.signinSilent();
    return user ? read(user) : null;
  } catch {
    // Signed out, or the provider will not answer in a frame. Either way the
    // person is anonymous and the page should say so rather than throw.
    announce(null);
    return null;
  }
}

export interface SignInOptions {
  /** The address typed into the form, so the provider can skip asking again. */
  email?: string;
  /** Which federated identity to jump to: `"google"` or `"sso"`. */
  via?: "google" | "sso";
  /** A path on this site to come back to. Same-origin paths only. */
  returnTo?: string;
  /**
   * What to ask the provider for: `"select_account"` when someone says they are
   * not the person it remembers, `"login"` to force credentials again. Omitted,
   * the provider reuses its own session if it has one.
   */
  prompt?: "login" | "select_account" | "consent";
}

/** Leaves for the provider. Resolves only if the redirect could not start. */
export async function signIn({ email, via, returnTo, prompt }: SignInOptions = {}) {
  const oidc = client();
  if (!oidc) throw new Error("no identity provider is configured");

  const hint = via ? IDP[via] : "";
  await oidc.signinRedirect({
    prompt,
    login_hint: email || undefined,
    extraQueryParams: hint ? { [IDP.param]: hint } : undefined,
    state: safeReturn(returnTo),
  });
}

/**
 * Finishes the flow on the callback page: checks `state`, exchanges the code
 * with the verifier, validates the id token. Returns where to go next.
 */
export async function completeSignIn(): Promise<string> {
  const oidc = client();
  if (!oidc) throw new Error("no identity provider is configured");

  const user = await oidc.signinCallback(window.location.href);
  // The code and state stay in history and in any referrer otherwise. They are
  // spent, but a spent code in a bookmark is still a code in a bookmark.
  window.history.replaceState({}, "", ROUTES.callback);
  return safeReturn(typeof user?.state === "string" ? user.state : undefined);
}

/**
 * Ends the session in both places. Local state goes first, so a provider that
 * is slow or unreachable cannot leave this browser holding a signed-in page.
 */
export async function signOut() {
  const oidc = client();
  if (!oidc) return;
  await oidc.removeUser();
  announce(null);
  try {
    await oidc.signoutRedirect();
  } catch (error) {
    console.warn("provider sign-out failed", error);
    window.location.href = ROUTES.home;
  }
}

/**
 * A path on this site, or the home page.
 *
 * Whatever is handed back after a redirect has been outside the site and can
 * say anything; sending a freshly signed-in person to an attacker's copy of the
 * login page on the strength of it is the oldest trick there is. Only a plain
 * absolute path is accepted — no scheme, no host, and not `//host`, which a
 * browser reads as one.
 */
function safeReturn(path: string | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return ROUTES.home;
  return path;
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
