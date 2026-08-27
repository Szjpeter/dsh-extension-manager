// Tiny helpers shared across the persistence core. Kept dependency-free so
// every lib module (and the offline test harness) can import it safely.

/**
 * Stable lowercase kebab-case slug — the canonical key for skill names and
 * local plugin slugs. Previously copied verbatim into skills.mjs,
 * github.mjs and list.mjs; single source of truth since v0.2.2.
 */
export function kebab(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
