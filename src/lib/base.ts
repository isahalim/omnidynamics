/**
 * The path everything on this site hangs off.
 *
 * The site is served from the root of its own domain, and mirrored onto GitHub
 * Pages under the repository's name — so the same source has to be able to ask
 * for `/glass/rounded-tetrahedron.mesh` or
 * `/omnidynamics/glass/rounded-tetrahedron.mesh` depending on which build it is
 * in. Astro puts that prefix in `BASE_URL`; every absolute route and public
 * asset in the project goes through here rather than being written as a
 * literal, because a mesh or a cubemap that 404s takes the whole canvas with it
 * and there is nothing left on the page to say why.
 *
 * `BASE` is the prefix itself, with no trailing slash. Prefer it for a constant
 * evaluated as a module loads: a template literal is plainly free of side
 * effects, where a call is not, and the bundler will drop an unused one instead
 * of stranding it in a chunk without its import. `withBase` is for everywhere
 * else — inside a function, or in a component's markup.
 */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/** Prefixes a root-relative path — `/glass/x.mesh`, `/soon/drone/` — with it. */
export function withBase(path: string): string {
  return `${BASE}${path}`;
}
