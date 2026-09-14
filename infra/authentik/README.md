# authentik

The identity provider the site signs people in against, self-hosted.

Nothing about sign-in lives at a vendor. authentik ([MIT]) runs here; Google is
federated *behind* it as one source among however many are added later, so the
site speaks one protocol — OpenID Connect, authorization code with PKCE — no
matter what a person actually clicked.

[MIT]: https://github.com/goauthentik/authentik/blob/main/LICENSE

## What is declared where

`blueprints/omnidynamics.yaml` is the configuration. authentik discovers and
applies every `*.yaml` under `/blueprints`, matching entries by their
`identifiers` and updating in place, so the file is idempotent and a fresh
machine reaches the same state as this one without anyone clicking through the
admin interface. It declares:

| | |
|---|---|
| `omnidynamics` provider | the site's **public** OAuth client — `authorization_code` + `refresh_token` only, PKCE, exact redirect URIs |
| `omnidynamics` application | what a person sees on the consent screen |
| `google` source | Google OAuth, credentials read from the environment |
| `google` flow | one redirect stage, so "Continue with Google" is one navigation rather than two |

The two Google credentials are the only values held out of git, because they are
the only two in the system that are genuinely secret. Everything else here is
public by construction.

## Running it

```sh
cp .env.example .env      # then fill it in
docker compose up -d
```

First run only, to create the admin account, open
<http://localhost:9000/if/flow/initial-setup/>.

The admin interface is at <http://localhost:9000/if/admin/>. Treat it as a
window onto the blueprint, not a place to make changes — anything set there that
the blueprint also names is overwritten the next time it is applied.

## Adding Google

1. In [Google Cloud Console] → **APIs & Services** → **Credentials**, create an
   **OAuth client ID** of type **Web application**.
2. Under **Authorized redirect URIs** add, verbatim:

   ```
   http://localhost:9000/source/oauth/callback/google/
   ```

   The trailing `google` is the source's slug, and the trailing slash matters.
   Add one line per origin authentik is reached on.
3. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, then:

   ```sh
   docker compose up -d
   docker compose exec worker ak apply_blueprint custom/omnidynamics.yaml
   ```

   The second command is what makes a credentials-only change take effect:
   discovery re-applies a blueprint when the *file* changes, and this change is
   in the environment around it.

[Google Cloud Console]: https://console.cloud.google.com/apis/credentials

## How "Continue with Google" skips a screen

authentik has no `kc_idp_hint`. An authorization request cannot name the
upstream identity it wants, so the site cannot ask for Google on the way in —
which normally means a person lands on authentik's login screen and picks Google
there, one screen and one click more than they expected.

The flow declared here closes that gap using only what the free tier has. The
site sends people to

```
http://localhost:9000/if/flow/google/?next=<url-encoded relative authorize url>
```

and then:

1. the flow executor stores that `next` against the session,
2. the flow's single redirect stage bounces the browser to
   `/source/oauth/login/google/`,
3. Google authenticates the person and returns to authentik's source callback,
4. the source's flow manager reads the stored `next` back out and resumes the
   authorization it interrupted, and
5. the site's callback page receives the code as if nothing unusual happened.

`next` must be a *relative* URL; authentik rejects an absolute one, which is
what stops that parameter being an open redirect. The site builds it in
`src/lib/auth/session.ts`.

## State

`authentik_database` — a named Docker volume — is the only state that matters.
`./data` is uploaded media, `./certs` the generated signing keys; both are
gitignored and both are rebuilt on a fresh install. The project name is pinned
to `authentik` in `compose.yaml` so the volume keeps its name if this directory
ever moves.
