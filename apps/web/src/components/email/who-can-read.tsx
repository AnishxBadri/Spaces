import { Link } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Earth, icon } from '#/components/icons'
import { LedgerRow } from '#/components/ledger-section'
import { PickPopover } from '#/components/record/details-add'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Switch } from '#/components/ui/switch'
import { listMembers, setEmailAudience } from '#/lib/server-fns'
import type { EmailPrivacy, EmailWider } from '#/lib/server-fns'
import { recordPath } from '#/lib/record-path'
import { cn } from '#/lib/utils'

type Member = { id: string; name: string }

/** A row of the window: the ledger's 40px on a rule, on the body's own edge. */
function Row({
  children,
  last,
  lead = false,
}: {
  children: ReactNode
  last: boolean
  /** Led by an icon, which sits 8px from its text. */
  lead?: boolean
}) {
  return (
    <LedgerRow last={last} className={cn('px-0', lead && 'gap-2')}>
      {children}
    </LedgerRow>
  )
}

/**
 * The first row when something past this window already opens the body to
 * the workspace: the mailbox, linking to its Mail sync settings, or the
 * owner's override on another record, linking to that record.
 */
function WiderLine({ wider, last }: { wider: EmailWider; last: boolean }) {
  const to = wider.kind === 'record' ? recordPath(wider.record) : null
  return (
    <Row last={last} lead>
      <Earth aria-hidden className="size-4 shrink-0" />
      {wider.kind === 'mailbox' ? (
        <>
          <span className="min-w-0 flex-1 truncate text-ui">
            Your mailbox is shared with the workspace
          </span>
          <Link
            to="/settings/email-calendar/$connectionId"
            params={{ connectionId: wider.connectionId }}
            className="focus-ring shrink-0 text-label hover:underline"
          >
            Mail sync ›
          </Link>
        </>
      ) : (
        <span className="min-w-0 flex-1 truncate text-ui">
          Shared through{' '}
          {to === null ? (
            wider.record.name
          ) : (
            <Link to={to} className="focus-ring hover:underline">
              {wider.record.name}
            </Link>
          )}
        </span>
      )}
    </Row>
  )
}

/**
 * Who can read this: what already opens the body wider, the owner, the
 * members granted this one email (each removable), a member to add, and —
 * opened from a record — the switch for every email the owner has with it.
 * Saving writes the grants and the switch at once, widening or narrowing.
 */
export function WidenDialog({
  emailId,
  privacy,
  open,
  onOpenChange,
  onSaved,
}: {
  emailId: string
  privacy: EmailPrivacy
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [members, setMembers] = useState<Array<Member> | null>(null)
  const [record, setRecord] = useState(privacy.record?.on ?? false)
  const [granted, setGranted] = useState<Array<Member>>(() =>
    privacy.grantees.map((g) => ({ id: g.id, name: g.name })),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRecord(privacy.record?.on ?? false)
    setGranted(privacy.grantees.map((g) => ({ id: g.id, name: g.name })))
    setError(null)
    let live = true
    listMembers()
      .then((rows) => {
        if (live)
          setMembers(rows.filter((m) => !m.banned && m.id !== privacy.owner.id))
      })
      .catch(() => {
        if (live) setMembers([])
      })
    return () => {
      live = false
    }
  }, [open, privacy])

  const addable = useMemo(
    () => (members ?? []).filter((m) => !granted.some((g) => g.id === m.id)),
    [members, granted],
  )
  // Stable while the list is, so the picker searches again only when it changes.
  const search = useCallback(
    (q: string) => {
      const term = q.toLowerCase()
      return Promise.resolve(
        addable.filter((m) => m.name.toLowerCase().includes(term)),
      )
    },
    [addable],
  )
  // While the members load the row stays; once nobody is left to add it goes.
  const canAdd = members === null || addable.length > 0
  // The switch row ends the list on no rule; without it the last row does.
  const endsOnSwitch = privacy.record !== null

  async function save() {
    setSaving(true)
    try {
      await setEmailAudience({
        data: {
          interactionId: emailId,
          userIds: granted.map((g) => g.id),
          record:
            privacy.record === null
              ? null
              : { id: privacy.record.id, workspace: record },
        },
      })
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="s" className="flex max-h-[70vh] flex-col">
        <DialogHeader>
          <DialogTitle>Who can read this</DialogTitle>
        </DialogHeader>
        <DialogDescription className="sr-only">
          The members who read this email
        </DialogDescription>
        <div className="-mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <ol>
            {privacy.wider === null ? null : (
              <WiderLine wider={privacy.wider} last={false} />
            )}
            <Row last={!endsOnSwitch && granted.length === 0 && !canAdd}>
              <span className="min-w-0 flex-1 truncate text-body">
                {privacy.owner.name}
              </span>
              <span className="shrink-0 mono text-micro text-graphite">
                Owner
              </span>
            </Row>
            {granted.map((g, i) => (
              <Row
                key={g.id}
                last={!endsOnSwitch && !canAdd && i === granted.length - 1}
              >
                <span className="min-w-0 flex-1 truncate text-body">
                  {g.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${g.name}`}
                  onClick={() =>
                    setGranted((prev) => prev.filter((p) => p.id !== g.id))
                  }
                  className="focus-ring shrink-0 text-graphite hover:text-foreground"
                >
                  <icon.close className="size-4" />
                </button>
              </Row>
            ))}
            {canAdd ? (
              <Row last={!endsOnSwitch}>
                <PickPopover
                  trigger={
                    <button
                      type="button"
                      className="focus-ring flex h-full min-w-0 flex-1 items-center gap-2 text-left text-ui text-graphite hover:text-foreground"
                    >
                      <icon.new aria-hidden className="size-4 shrink-0" />
                      <span className="min-w-0 truncate">Add a person…</span>
                    </button>
                  }
                  placeholder="Add a person…"
                  eager
                  search={search}
                  onPick={(m) => {
                    setGranted((prev) => [...prev, { id: m.id, name: m.name }])
                    return Promise.resolve()
                  }}
                />
              </Row>
            ) : null}
            {privacy.record === null ? null : (
              <li className="flex h-12 items-center gap-3">
                <label className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-ui">
                    Every email I have with {privacy.record.name}
                  </span>
                  <Switch
                    checked={record}
                    onCheckedChange={setRecord}
                    aria-label={`Every email I have with ${privacy.record.name}`}
                  />
                </label>
              </li>
            )}
          </ol>
          {error === null ? null : (
            <p className="text-ui text-destructive">{error}</p>
          )}
        </div>
        <DialogFooter note="Subject, people and date stay visible to all">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} pending={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
