/**
 * Where `‹ Settings` and `esc` go back to: the last app page the reader was
 * on before settings, or Today on a cold load into settings.
 *
 * - Written only from an effect, so the server never holds a reader's page.
 * - Per tab and per page load, like the back stack it stands in for.
 */

export const SETTINGS_FALLBACK = '/today'

let last: string | null = null

/** Whether a path is inside the settings shell. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

/** Record an app page; a settings page is never one. */
export function rememberAppPage(pathname: string, href: string): void {
  if (!isSettingsPath(pathname)) last = href
}

/** The page settings returns to. */
export function settingsReturnHref(): string {
  return last ?? SETTINGS_FALLBACK
}

/** Forget the remembered page — for tests. @public */
export function forgetAppPage(): void {
  last = null
}
