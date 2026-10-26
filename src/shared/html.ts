/**
 * Minimal render-time HTML escaping for dynamic values interpolated into
 * HTML output (admin portal page, HTML email templates).
 *
 * NOTE: `sanitizeForSheet` only defends against Google Sheets formula
 * injection — it is NOT an HTML sanitizer. Any customer-controlled or
 * order-derived value that lands in an HTML text node, a quoted attribute
 * value, or an inline <script> block MUST pass through the helpers below.
 */

/**
 * Escapes `& < > " '` so the value is safe in HTML text nodes AND in
 * single-/double-quoted attribute values. Non-string values are stringified;
 * null/undefined render as empty string.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON-encodes a value for safe inlining inside an inline <script> block.
 * On top of `JSON.stringify`, escapes `<` (blocks a `</script>` breakout)
 * and the U+2028/U+2029 line separators (invalid in old JS string literals).
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
