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
      // Light, literally: the app is light by decision and has no dark token
      // values, so 'system' would hand sonner's dark styling to a dark OS. The
      // four --normal-* overrides below set the palette either way.
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      // Toast · ink: inverted sheet, 0 radius, on the
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
