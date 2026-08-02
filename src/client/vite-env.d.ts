/// <reference types="vite/client" />

/**
 * The running release, substituted into the bundle at build time from
 * `package.json`'s `version` by the `define` in vite.config.ts (and mirrored
 * in vitest.client.config.ts, or it would be `undefined` under the client
 * tests). Declared here rather than imported so there is exactly one source
 * of truth for the number: a string typed into a component could drift from
 * the package and from CHANGELOG.md the moment either moved.
 */
declare const __APP_VERSION__: string;
