import { defineConfig } from 'astro/config';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

// The site lives at its own domain and is mirrored onto GitHub Pages, which
// serves a project site from a subdirectory. One build has to be able to be
// either, so both come from the environment and everything in the project asks
// `src/lib/base.ts` for its prefix rather than writing an absolute path.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://omnidynamics.dev',
  base: process.env.SITE_BASE ?? '/',
  // `/contact/` was the way to reach us and is linked from outside the site, so
  // it still resolves — at the page that replaced it. A static build emits a
  // small redirecting document rather than a 301, which is the most a bucket of
  // files can do and is enough for a link someone kept.
  // (One entry: the Worker's `auto-trailing-slash` handling resolves the
  // unslashed form to this one before the redirect is ever reached.)
  redirects: { '/contact/': '/book/' },
  vite: {
    // vgpu shaders import each other; the plugin resolves that graph and emits
    // each .wgsl file as a linked module string.
    plugins: [wgslVitePlugin()],
  },
});
