// The Split tool's pointer: a scissors glyph riding a vertical cut hairline
// (inline SVG data-URI). The HOTSPOT sits ON the hairline at the blade
// crossing (11, 8) — the cut lands exactly where the operator sees the line.

const SPLIT_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><g fill="none" stroke="#0e0f10" stroke-width="3.4" stroke-linecap="round"><path d="M11 1v13"/><path d="M11 8L6.6 14.2"/><path d="M11 8l4.4 6.2"/><circle cx="5.4" cy="16.6" r="2.3"/><circle cx="16.6" cy="16.6" r="2.3"/></g><g fill="none" stroke="#f0f1f2" stroke-width="1.5" stroke-linecap="round"><path d="M11 1v13"/><path d="M11 8L6.6 14.2"/><path d="M11 8l4.4 6.2"/><circle cx="5.4" cy="16.6" r="2.3"/><circle cx="16.6" cy="16.6" r="2.3"/></g></svg>`;

/** CSS `cursor` value for every surface the blade is live on. */
export const SPLIT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  SPLIT_CURSOR_SVG,
)}") 11 8, col-resize`;
