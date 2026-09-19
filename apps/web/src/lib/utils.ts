import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * tailwind-merge cannot tell a custom text size (`text-ui`) from a custom
 * text colour (`text-graphite`) — both are `text-<word>` — and drops one when
 * they meet. Naming the type-scale steps here keeps a size and a colour from
 * ever cancelling each other out.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['micro', 'label', 'ui', 'body', 'title', 'page', 'display'] },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
