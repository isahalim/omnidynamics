/// <reference types="astro/client" />

/**
 * Everything the browser is allowed to know, and therefore everything that is
 * compiled into the bundle. `PUBLIC_` is Astro's word for "this ships"; the
 * sign-in holds no secret because there is no secret to hold — a client id is
 * an identifier — and the booking link is a public URL. See `.env.example`.
 */
interface ImportMetaEnv {
  readonly PUBLIC_GOOGLE_CLIENT_ID?: string;
  readonly PUBLIC_CAL_LINK?: string;
  readonly PUBLIC_CAL_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
