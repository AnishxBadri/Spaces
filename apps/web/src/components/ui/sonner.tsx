import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { Toaster as Sonner } from 'sonner'
import type { ToasterProps } from 'sonner'

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      // Light, literally (2026-09-19, SPA-52). This read `useTheme()` from
      // next-themes with no ThemeProvider mounted anywhere, so the value was
      // always the default 'system' — which handed sonner's own dark styling
      // to an operator on a dark OS, on an app with no dark token values. The
      // app is light by decision; the toast palette is set by the four
      // --normal-* overrides below either way, so nothing renders differently
      // for a user on a light OS.
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // Toast · ink (DESIGN.md depth scale): inverted sheet, 0 radius, on the
      // toast layer. Inline zIndex wins over sonner's own stylesheet value.
      style={
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- CSS custom properties are not part of React.CSSProperties
        {
          '--normal-bg': 'var(--foreground)',
          '--normal-text': 'var(--background)',
          '--normal-border': 'var(--hairline)',
          '--border-radius': '0px',
          zIndex: 'var(--z-toast)',
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
