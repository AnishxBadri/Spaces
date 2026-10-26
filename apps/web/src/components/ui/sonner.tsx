import { Toaster as Sonner, toast } from 'sonner'
import type { ToasterProps } from 'sonner'

import { Twinkle } from '#/components/twinkle'

/** How long a toast holds; its action's drain line runs for the same time. */
export const TOAST_MS = 4000

/**
 * An error stays until it is dismissed, by its `×`. Every caller reaches
 * sonner's one shared `toast`, so the default is set on it here, once, where
 * the Toaster is defined; a caller's own `duration` or `closeButton` wins.
 */
const sonnerError = toast.error
toast.error = (message, data) =>
  sonnerError(message, { duration: Infinity, closeButton: true, ...data })

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      // Light, literally: the app is light by decision and has no dark token
      // values, so 'system' would hand sonner's dark styling to a dark OS. The
      // --normal-* overrides below set the palette either way.
      theme="light"
      className="toaster group"
      duration={TOAST_MS}
      // No icon says what the words already say; a toast still working
      // carries the Twinkle, paper on graphite.
      icons={{
        success: null,
        info: null,
        warning: null,
        error: null,
        loading: <Twinkle tone="paper" />,
        close: <span aria-hidden>×</span>,
      }}
      toastOptions={{ closeButtonAriaLabel: 'Dismiss' }}
      // Toast · ink: inverted sheet, 0 radius, on the toast layer; the rest
      // of its anatomy is the stylesheet's, which has to out-rank sonner's
      // own. Inline zIndex wins over sonner's own stylesheet value.
      style={
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- CSS custom properties are not part of React.CSSProperties
        {
          '--normal-bg': 'var(--foreground)',
          '--normal-text': 'var(--background)',
          '--normal-border': 'var(--hairline)',
          '--border-radius': '0px',
          '--toast-duration': `${TOAST_MS}ms`,
          zIndex: 'var(--z-toast)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
