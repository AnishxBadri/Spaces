import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { Toaster as Sonner } from 'sonner'
import type { ToasterProps } from 'sonner'

const THEMES: Array<NonNullable<ToasterProps['theme']>> = [
  'light',
  'dark',
  'system',
]

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  // next-themes hands back a bare string; Sonner's prop is its own union.
  const named = THEMES.find((t) => t === theme) ?? 'system'

  return (
    <Sonner
      theme={named}
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
