/// <reference types="astro/client" />

/**
 * Everything the browser is allowed to know, and therefore everything that is
 * compiled into the bundle. `PUBLIC_` is Astro's word for "this ships"; the
 * sign-in holds no secret because a public OAuth client cannot keep one, and
 * the booking link is a public URL. See `.env.example`.
 */
interface ImportMetaEnv {
  readonly PUBLIC_OIDC_ISSUER?: string;
  readonly PUBLIC_OIDC_CLIENT_ID?: string;
  readonly PUBLIC_OIDC_SCOPE?: string;
  readonly PUBLIC_OIDC_FLOW_GOOGLE?: string;
  readonly PUBLIC_OIDC_FLOW_SSO?: string;
  readonly PUBLIC_CAL_LINK?: string;
  readonly PUBLIC_CAL_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
