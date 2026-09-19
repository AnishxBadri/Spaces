//  @ts-check

/**
 * `instrument/vocabulary` — only Instrument words reach a class string.
 *
 * Replaces the CLAUDE.md gate-5 grep (deleted 2026-09-18). The grep read the
 * whole file, so `rounded(?![-\w])` could not tell a class from the word
 * "rounded" in a comment — it printed a false positive on
 * `attribute-dialog.tsx:981` forever. This reads className string literals and
 * the string arguments of `cn()` / `cva()` and nothing else, so prose is
 * invisible to it, and it names the Instrument replacement in every message.
 *
 * It also covers the half of the vocabulary the grep never mentioned: the
 * shadcn semantic colour names (sidebar, chart-N, card, popover, secondary,
 * muted as a class, background outside the root route). Those `--color-*`
 * exports are gone from the `@theme` block in `src/styles.css`;
 * `design-tokens.test.ts` keeps them gone.
 *
 * DESIGN.md is the source for the replacements: `text-graphite`, `border-rule`,
 * `bg-bone`, `bg-paper`, `text-label`, `text-ui`, `rounded-md` / `rounded-none`.
 *
 * SPA-79 adds the other way the vocabulary leaks: an arbitrary type size.
 * DESIGN.md §3 ends "if a size isn't on the list it does not go in the app",
 * and `text-[0.625rem]` / `leading-[1.125rem]` are how the list gets bypassed —
 * forty sites had spelled the 10px field step out by hand before it existed as
 * a token. Both are banned, with the nearest named step in the message. Only
 * *lengths* are banned: `text-[var(--badge-amber-ink)]` is a colour, and the
 * two-tier colour rule is a different axis with its own slice. A genuine
 * one-off (optical sizing of initials inside a 16–22px square) takes an inline
 * comment saying why plus a scoped disable — the honest form of an exception.
 *
 * SPA-52 adds the colour axis SPA-79 left open. The app is light by decision
 * (2026-09-19): `color-scheme: light` on `:root`, no `dark` custom-variant, no
 * next-themes. Dark stays a backlog feature, and what keeps it a second token
 * file rather than a redraw is that no surface ever writes a colour value
 * down — so a raw hex (`bg-[#f4f3ef]`), or an `rgb()` / `hsl()` / `oklch()`
 * spelled into a class string, is an error naming the tokens. Reading a custom
 * property is the sanctioned arbitrary value: `bg-[var(--badge-amber)]` passes,
 * because the token is still the one place the value lives. The tree had zero
 * occurrences when the check landed, and this is what keeps it at zero.
 */

/**
 * The named type steps, in rem, smallest first. Diffed against the `--text-*`
 * custom properties in `src/styles.css` by `design-tokens.test.ts`, so the
 * "nearest step" in a message cannot drift from the real tokens.
 *
 * @type {Array<{ name: string, rem: number, lineRem: number }>}
 */
export const NAMED_STEPS = [
  { name: 'field', rem: 0.625, lineRem: 0.75 },
  { name: 'micro', rem: 0.6875, lineRem: 1 },
  { name: 'label', rem: 0.75, lineRem: 1 },
  { name: 'ui', rem: 0.8125, lineRem: 1.25 },
  { name: 'body', rem: 0.875, lineRem: 1.25 },
  { name: 'title', rem: 0.9375, lineRem: 1.375 },
  { name: 'page', rem: 1.375, lineRem: 1.75 },
  { name: 'display', rem: 1.625, lineRem: 2 },
]

/** Tailwind's spacing unit — the scale `leading-<number>` multiplies. */
const SPACING_REM = 0.25

/**
 * @typedef {{ re: RegExp, use: string }} Ban
 */

/** @type {Array<Ban>} */
const BANS = [
  // Type scale — named steps only (DESIGN.md §2).
  { re: /^text-xs$/, use: 'text-label' },
  { re: /^text-sm$/, use: 'text-ui' },

  // Radius — Instrument has exactly two (2px, or square).
  {
    re: /^rounded$/,
    use: 'rounded-md (2px) or rounded-none',
  },
  {
    re: /^rounded-(sm|lg|xl|2xl|3xl|full)$/,
    use: 'rounded-md (2px) or rounded-none',
  },

  // Elevation — Instrument draws depth as a hard ink offset, never a blur.
  {
    re: /^shadow-xs$/,
    use: 'shadow-[2px_2px_0_0_var(--hairline)], or no shadow at all',
  },

  // Structure.
  { re: /^border-border$/, use: 'border-rule' },
  { re: /^border-input$/, use: 'border-rule' },

  // The shadcn semantic colours. Everything below aliased bone, paper,
  // hairline or ink, so each swap renders identically.
  {
    re: /^(bg|border|ring|divide|outline|fill|stroke)-muted(-foreground)?$/,
    use: 'bg-bone',
  },
  {
    re: /^text-muted(-foreground)?$/,
    use: 'text-graphite',
  },
  {
    re: /^(bg|border|ring|divide|outline|fill|stroke)-accent(-foreground)?$/,
    use: 'bg-bone',
  },
  {
    re: /^text-accent-foreground$/,
    use: 'text-foreground',
  },
  {
    re: /^(bg|border|ring|divide|outline|fill|stroke)-secondary(-foreground)?$/,
    use: 'bg-bone',
  },
  {
    re: /^text-secondary-foreground$/,
    use: 'text-foreground',
  },
  {
    re: /^(bg|border|ring|divide|outline|fill|stroke)-card(-foreground)?$/,
    use: 'bg-paper',
  },
  {
    re: /^text-card-foreground$/,
    use: 'text-foreground',
  },
  {
    re: /^(bg|border|ring|divide|outline|fill|stroke)-popover(-foreground)?$/,
    use: 'bg-paper',
  },
  {
    re: /^text-popover-foreground$/,
    use: 'text-foreground',
  },
  {
    re: /(^|-)sidebar(-|$)/,
    use: 'bg-bone for the chassis, border-hairline for its edge',
  },
  {
    re: /(^|-)chart-[1-5](-|$)/,
    use: 'the badge palette (--badge-*), or ink and dither',
  },
]

/** `bg-background` is legal only where the document ground is painted. */
const ROOT_ROUTE = '__root.tsx'

/**
 * Split a Tailwind class into its variant prefixes and the utility itself,
 * ignoring `:` that sits inside `[...]` or `(...)` (arbitrary variants and
 * values carry their own colons).
 *
 * @param {string} token
 * @returns {{ variants: Array<string>, utility: string }}
 */
function splitVariants(token) {
  /** @type {Array<string>} */
  const variants = []
  let depth = 0
  let start = 0
  for (let i = 0; i < token.length; i++) {
    const c = token[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (c === ':' && depth === 0) {
      variants.push(token.slice(start, i))
      start = i + 1
    }
  }
  return { variants, utility: token.slice(start) }
}

/**
 * Strip `!` / `-` prefixes and any `/opacity` suffix that is not inside
 * brackets, so `hover:bg-muted/50` is judged as `bg-muted`.
 *
 * @param {string} utility
 * @returns {string}
 */
function normalize(utility) {
  let out = utility.replace(/^[!-]+/, '')
  let depth = 0
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (c === '[' || c === '(') depth++
    else if (c === ']' || c === ')') depth--
    else if (c === '/' && depth === 0) {
      out = out.slice(0, i)
      break
    }
  }
  return out
}

/**
 * Every violation in one class string, as offsets into that string.
 *
 * @param {string} value
 * @param {boolean} isRootRoute
 * @returns {Array<{ index: number, length: number, token: string, use: string }>}
 */
export function findBannedTokens(value, isRootRoute) {
  /** @type {Array<{ index: number, length: number, token: string, use: string }>} */
  const found = []
  const re = /\S+/g
  let m
  while ((m = re.exec(value)) !== null) {
    const raw = m[0]
    const at = { index: m.index, length: raw.length }
    const { variants, utility } = splitVariants(raw)

    if (variants.includes('dark')) {
      found.push({
        ...at,
        token: raw,
        use: 'nothing — the app is light by decision (2026-09-19) and the `dark` custom-variant is gone from styles.css; drop the variant',
      })
      continue
    }

    const name = normalize(utility)
    if (name === 'bg-background') {
      if (!isRootRoute) {
        found.push({
          ...at,
          token: name,
          use: 'bg-paper (bg-background is the document ground, __root.tsx only)',
        })
      }
      continue
    }

    const ban = BANS.find((b) => b.re.test(name))
    if (ban) found.push({ ...at, token: name, use: ban.use })
  }
  return found
}

/** A CSS length inside arbitrary-value brackets, in rem. Null if not a length. */
function remValue(/** @type {string} */ raw) {
  const m = /^(\d*\.?\d+)(rem|px|em)$/.exec(raw.trim())
  if (!m) return null
  return m[2] === 'px' ? Number(m[1]) / 16 : Number(m[1])
}

/** px, for messages — the sizes are discussed in px and written in rem. */
function px(/** @type {number} */ rem) {
  return `${Math.round(rem * 16)}px`
}

/** The step closest to a size, so a message can name it. */
function nearestStep(/** @type {number} */ rem) {
  return NAMED_STEPS.reduce((best, step) =>
    Math.abs(step.rem - rem) < Math.abs(best.rem - rem) ? step : best,
  )
}

/**
 * Every arbitrary type size in one class string (DESIGN.md §3). Exported for
 * the fixture test.
 *
 * @param {string} value
 * @returns {Array<{ index: number, length: number, token: string, fix: string }>}
 */
export function findArbitraryType(value) {
  /** @type {Array<{ index: number, length: number, token: string, fix: string }>} */
  const found = []
  const re = /\S+/g
  let m
  while ((m = re.exec(value)) !== null) {
    const raw = m[0]
    const at = { index: m.index, length: raw.length }
    const name = normalize(splitVariants(raw).utility)

    const size = /^text-\[([^\]]+)\]$/.exec(name)
    if (size) {
      const rem = remValue(size[1])
      if (rem === null) continue
      const step = nearestStep(rem)
      found.push({
        ...at,
        token: name,
        fix:
          step.rem === rem
            ? `text-${step.name} — this is that step (${px(step.rem)}) spelled out by hand`
            : `text-${step.name} (${px(step.rem)}), the nearest named step to ${px(rem)}; a genuine optical one-off takes a comment saying why and a scoped disable`,
      })
      continue
    }

    const line = /^leading-\[([^\]]+)\]$/.exec(name)
    if (line) {
      const rem = remValue(line[1])
      if (rem === null) continue
      const step = NAMED_STEPS.find((s) => s.lineRem === rem)
      const units = rem / SPACING_REM
      found.push({
        ...at,
        token: name,
        fix: step
          ? `nothing — ${px(rem)} is the \`${step.name}\` step's own leading, so text-${step.name} already carries it`
          : `leading-${Number.isInteger(units) ? units : String(units)} (the 0.25rem scale)`,
      })
    }
  }
  return found
}

/**
 * A hex colour written out: `#fff`, `#ffff`, `#f4f3ef`, `#f4f3efcc`. The
 * trailing guard keeps a longer hex from matching as a shorter one.
 */
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])/

/**
 * A colour function spelled into a class string. `color-mix()` is deliberately
 * absent — it mixes tokens rather than stating a value, and the `-` keeps it
 * off `color(`.
 */
const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/

/**
 * Every raw colour in one class string (SPA-52). Exported for the fixture test.
 *
 * @param {string} value
 * @returns {Array<{ index: number, length: number, token: string, literal: string }>}
 */
export function findRawColour(value) {
  /** @type {Array<{ index: number, length: number, token: string, literal: string }>} */
  const found = []
  const re = /\S+/g
  let m
  while ((m = re.exec(value)) !== null) {
    const raw = m[0]
    const hex = HEX.exec(raw)
    if (hex) {
      found.push({
        index: m.index,
        length: raw.length,
        token: raw,
        literal: hex[0],
      })
      continue
    }
    const fn = COLOUR_FN.exec(raw)
    if (fn) {
      found.push({
        index: m.index,
        length: raw.length,
        token: raw,
        literal: fn[0].slice(0, -1),
      })
    }
  }
  return found
}

/** @type {import('eslint').Rule.RuleModule} */
export const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Hold class strings to the Instrument vocabulary; name the replacement.',
    },
    schema: [],
    messages: {
      notInstrument:
        '`{{token}}` is not an Instrument token — use {{use}} (DESIGN.md "The seven rules").',
      arbitraryType:
        'arbitrary type size `{{token}}` — use {{fix}}. DESIGN.md §3: if a size isn’t on the list it does not go in the app.',
      rawColour:
        'raw colour `{{literal}}` in `{{token}}` — every colour in the app is a token. Use the vocabulary (bg-paper, bg-bone, border-rule, text-graphite, the --badge-* tints) or read the custom property, e.g. bg-[var(--badge-amber)]. DESIGN.md §2: the app is light by decision (2026-09-19) and stays token-only, which is what makes dark a token file later and not a redraw.',
    },
  },
  create(context) {
    const isRootRoute = context.filename.endsWith(ROOT_ROUTE)

    /**
     * Report every banned token in one class string. The report lands on the whole
     * string node: class strings are routinely multi-line template literals,
     * and column arithmetic across them buys nothing.
     *
     * @param {any} node
     * @param {string} value
     */
    function check(node, value) {
      for (const hit of findBannedTokens(value, isRootRoute)) {
        context.report({
          node,
          messageId: 'notInstrument',
          data: { token: hit.token, use: hit.use },
        })
      }
      for (const hit of findArbitraryType(value)) {
        context.report({
          node,
          messageId: 'arbitraryType',
          data: { token: hit.token, fix: hit.fix },
        })
      }
      for (const hit of findRawColour(value)) {
        context.report({
          node,
          messageId: 'rawColour',
          data: { token: hit.token, literal: hit.literal },
        })
      }
    }

    /**
     * Visit every string that can reach a class attribute from this node:
     * literals, template quasis, and the members of the arrays, objects and
     * conditionals that carry class strings (cva's variants are nested objects
     * of them).
     *
     * @param {any} node
     */
    function walkStrings(node) {
      if (node === null || typeof node !== 'object') return
      switch (node.type) {
        case 'Literal':
          if (typeof node.value === 'string') check(node, node.value)
          return
        case 'TemplateLiteral':
          for (const quasi of node.quasis) {
            check(quasi, quasi.value.cooked ?? quasi.value.raw)
          }
          for (const expr of node.expressions) walkStrings(expr)
          return
        case 'ArrayExpression':
          for (const el of node.elements) walkStrings(el)
          return
        case 'ObjectExpression':
          for (const prop of node.properties) {
            if (prop.type === 'Property') walkStrings(prop.value)
          }
          return
        case 'ConditionalExpression':
          walkStrings(node.consequent)
          walkStrings(node.alternate)
          return
        case 'LogicalExpression':
          walkStrings(node.left)
          walkStrings(node.right)
          return
        case 'CallExpression':
          // Handled by the CallExpression visitor below, which sees cn()/cva()
          // at any depth — recursing here would report each hit twice.
          return
        default:
          return
      }
    }

    return {
      JSXAttribute(node) {
        const attr = /** @type {any} */ (node)
        const name = attr.name?.name
        if (name !== 'className' && name !== 'class') return
        const value = attr.value
        if (value === null || value === undefined) return
        if (value.type === 'Literal') walkStrings(value)
        else if (value.type === 'JSXExpressionContainer')
          walkStrings(value.expression)
      },
      CallExpression(node) {
        const callee = /** @type {any} */ (node).callee
        const name =
          callee?.type === 'Identifier'
            ? callee.name
            : callee?.type === 'MemberExpression' &&
                callee.property?.type === 'Identifier'
              ? callee.property.name
              : null
        if (name !== 'cn' && name !== 'cva' && name !== 'twMerge') return
        for (const arg of /** @type {any} */ (node).arguments) walkStrings(arg)
      },
    }
  },
}

export default { rules: { vocabulary: rule } }
