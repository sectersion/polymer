/** Match the modifier shown in the console navigation shortcut tooltips. */
export function shortcutModifier(userAgent: string): "⌘" | "Ctrl" {
  return /Macintosh/.test(userAgent) ? "⌘" : "Ctrl";
}
