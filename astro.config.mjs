import { defineConfig } from 'astro/config';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

// The site lives at its own domain and is mirrored onto GitHub Pages, which
// serves a project site from a subdirectory. One build has to be able to be
// either, so both come from the environment and everything in the project asks
// `src/lib/base.ts` for its prefix rather than writing an absolute path.
export default defineConfig({
  site: process.env.SITE_URL ?? 'https://omnidynamics.dev',
  base: process.env.SITE_BASE ?? '/',
  vite: {
    // vgpu shaders import each other; the plugin resolves that graph and emits
    // each .wgsl file as a linked module string.
    plugins: [wgslVitePlugin()],
  },
});
