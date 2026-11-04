// Single source of truth for the frontend image URL.
//
// Why this exists: menu_pool.image_url / menu_jobs.image_url are dashscope
// temp URLs with a ~7d expiry. Using them directly as `<img src>` causes
// broken images once the URL expires. All view layers MUST route through
// `/menu/img/:pool_id`, which is served from D1's image_blob column and
// falls back to an SVG placeholder when the blob is missing.
//
// Usage:
//   <img src={getDisplayImageUrl({ id: row.menu_pool_id })} ... />
//
// Lint rule (informal): grep for raw `src={...image_url...}` in views/.
// Any new occurrence is a regression — wire it through this helper instead.

export function getDisplayImageUrl(row: { id: number }): string {
  return `/menu/img/${row.id}`;
}
