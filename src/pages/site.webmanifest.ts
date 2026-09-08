/**
 * The web app manifest, generated rather than served as a static file.
 *
 * Every path in it is absolute from the origin, and the site is mirrored onto
 * GitHub Pages under the repository's name — a manifest with `/icon-192.png`
 * in it would send the installer to the wrong place there, and an install with
 * a broken `start_url` fails silently. See `src/lib/base.ts`.
 */
import type { APIRoute } from "astro";

import { withBase } from "../lib/base";

const ICON = { sizes: "512x512", type: "image/png" } as const;

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      {
        name: "OmniDynamics",
        short_name: "OmniDynamics",
        description:
          "OmniDynamics builds embodied intelligence — drones, quadrupeds, " +
          "manipulators and humanoids.",
        start_url: withBase("/"),
        scope: withBase("/"),
        display: "standalone",
        background_color: "#d2ccc2",
        theme_color: "#d2ccc2",
        icons: [
          { src: withBase("/icon-192.png"), sizes: "192x192", type: "image/png" },
          { src: withBase("/icon-512.png"), ...ICON },
          { src: withBase("/icon-512.png"), ...ICON, purpose: "maskable" },
        ],
      },
      null,
      2
    ),
    { headers: { "content-type": "application/manifest+json" } }
  );
