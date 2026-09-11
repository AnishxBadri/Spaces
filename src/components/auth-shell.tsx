import type { ReactNode } from 'react'
import { Wordmark } from './wordmark'

/**
 * The auth sheet (login, setup, join): a 400px column on paper — the mark,
 * a mono caps eyebrow saying which step this is, a serif title, one sans
 * sentence, the form, and a mono foot. No card, no centering flourish:
 * the same anatomy as a page head, printed at the top of an empty field.
 */
export function AuthShell({
  eyebrow,
  title,
  blurb,
  foot,
  children,
}: {
  eyebrow: ReactNode
  title: ReactNode
  blurb?: ReactNode
  foot?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="flex min-h-dvh flex-col items-center bg-background px-6">
      <div className="flex w-full max-w-100 flex-col pt-[16vh] pb-16">
        <Wordmark />
        <div className="mt-8 flex flex-col gap-1.5 border-b border-hairline pb-4">
          <div className="mono text-micro leading-[0.875rem] tracking-[0.08em] text-graphite uppercase">
            {eyebrow}
          </div>
          <h1 className="title-serif">{title}</h1>
          {blurb ? <p className="text-ui text-graphite">{blurb}</p> : null}
        </div>
        <div className="pt-5">{children}</div>
        {foot ? (
          <p className="mt-6 mono text-micro text-graphite">{foot}</p>
        ) : null}
      </div>
    </main>
  )
}

/** A form-level error: crimson square, one sentence. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-center gap-2 text-ui text-destructive"
    >
      <span aria-hidden className="size-2 shrink-0 bg-destructive" />
      {children}
    </p>
  )
}

/** The sans line under a field that explains it. */
export function FieldHint({
  id,
  children,
}: {
  id?: string
  children: ReactNode
}) {
  return (
    <p id={id} className="text-label text-graphite">
      {children}
    </p>
  )
}
