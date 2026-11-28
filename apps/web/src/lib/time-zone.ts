/**
 * A time zone's name, read and checked. `Intl` is used for the name alone:
 * nothing here prints a date, so nothing here can differ between Node and
 * the browser on a page. Printed dates go through `@spaces/core/format`.
 */

/**
 * The reader's time zone as the server may use it; `UTC` when the name is
 * not one the runtime knows.
 */
export function knownTimeZone(tz: string | undefined): string {
  if (tz === undefined || tz === '') return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return 'UTC'
  }
}

/** The browser's time zone, by its IANA name; `UTC` where it cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}
