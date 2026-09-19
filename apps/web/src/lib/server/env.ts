/**
 * Required environment, read once and loudly. An absent variable is a boot
 * failure with a name in the message — never an empty string that turns into
 * a silent bad connection three layers down (CLAUDE.md "Principles": a type
 * is a claim the compiler checked; `?? ''` claims a value nobody supplied).
 */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required — set it in the environment`)
  return value
}
