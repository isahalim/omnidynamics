import { defineConfig } from 'astro/config';
import { wgslVitePlugin } from '@vgpu/wgsl/loader-vite';

export default defineConfig({
  site: 'https://omnidynamics.dev',
  vite: {
    // vgpu shaders import each other; the plugin resolves that graph and emits
    // each .wgsl file as a linked module string.
    plugins: [wgslVitePlugin()],
  },
});
