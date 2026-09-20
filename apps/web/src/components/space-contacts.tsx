import { Link, useRouter } from '@tanstack/react-router'
import { ChevronRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { LedgerRow, LedgerSection } from './ledger-section'
import { InitialsMark } from './record/record-parts'
import { Button } from './ui/button'
import { useConfirm } from './ui/confirm-dialog'
import type {
  InheritedContact,
  SpaceContact,
} from '#/lib/people/space-contacts'
import { recordPath } from '#/lib/record-path'
import { untagFromSpace } from '#/lib/server-fns'

/**
 * Contacts — the people of a space (SPA-99), the other half of CONTEXT's
 * "sources and contacts sections" open question and deliberately the *same*
 * shape docsurf-1b settled for Sources: the direct rows are the section, the
 * inherited ones are a disclosure under them, closed on first render and
 * absent entirely when the lane is empty.
 *
 * The distinction the two lanes draw is the point of the section. A person
 * with an `entity_space` row here was put here on purpose, so they carry the
 * headline count, the header readout, and the only remove control on the
 * page. A person reached through a company tagged here is a convenience —
 * nobody filed them, so nothing here can unfile them, and the row names the
 * company instead so it can say why it is on screen at all.
 *
 * Sources sits above this, Companies below: a space is read as reading
 * first, then who you know, then what falls out of both.
 */
export function SpaceContacts({
  spaceId,
  spaceName,
  contacts,
  inherited,
}: {
  spaceId: string
  spaceName: string
  contacts: Array<SpaceContact>
  /**
   * People reached through the companies tagged into this space. They render
   * in a closed disclosure under the tagged rows and are never counted
   * anywhere else on the page.
   */
  inherited: Array<InheritedContact>
}) {
  const router = useRouter()
  const { confirm, confirmDialog } = useConfirm()

  async function untag(c: SpaceContact) {
    const ok = await confirm({
      title: `Remove ${c.name} from ${spaceName}?`,
      body: `The person's record stays; only the tag into ${spaceName} goes.`,
      action: 'Remove',
    })
    if (!ok) return
    try {
      await untagFromSpace({ data: { entityId: c.id, spaceId } })
      void router.invalidate()
    } catch {
      toast.error(`Could not remove ${c.name} from ${spaceName}`)
    }
  }

  return (
    <>
      <LedgerSection
        label="Contacts"
        count={
          contacts.length === 0
            ? '0'
            : `${contacts.length} tagged here${
                inherited.length > 0 ? ` · ${inherited.length} inherited` : ''
              }`
        }
        link={
          contacts.length > 0 ? (
            <Link to="/people" className="focus-ring text-primary">
              all people ›
            </Link>
          ) : null
        }
      >
        {contacts.map((c) => (
          <ContactRow key={c.id} contact={c} onUntag={() => void untag(c)} />
        ))}

        {/* Empty is a row that says what belongs here, never an empty grid —
            and it is what a space with no tagged people shows even when the
            companies here have contacts of their own. */}
        {contacts.length === 0 ? (
          <LedgerRow last>
            <span className="w-3.5 shrink-0 text-center mono text-ui text-graphite">
              —
            </span>
            <span className="min-w-0 flex-1 truncate text-ui text-graphite">
              No one tagged into {spaceName} yet — tag a founder or an operator
              from their record.
            </span>
          </LedgerRow>
        ) : null}

        {/* The inherited lane: people the companies tagged in here bring
            with them. Closed on first render because it is a convenience and
            not a claim of tagging — `<details>` with no `open`, so "closed"
            is the markup's state and not a hook's, and the first paint on
            the server is already the closed one. Nothing at all when the
            lane is empty: an empty disclosure is a promise of content that
            isn't there. */}
        {inherited.length > 0 ? (
          <li>
            <details className="group/inherited">
              <summary className="focus-ring flex h-row cursor-pointer list-none items-center gap-2 border-b border-rule mono text-micro text-graphite transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight
                  className="size-3 shrink-0 transition-transform group-open/inherited:rotate-90"
                  strokeWidth={2}
                />
                {inherited.length} through companies here
              </summary>
              <ol>
                {inherited.map((c) => (
                  /* One row per (person, company) edge, so the key is the
                     pair: the same founder can be contact at two companies
                     that are both tagged in here. */
                  <InheritedContactRow
                    key={`${c.companyId}:${c.id}`}
                    contact={c}
                  />
                ))}
              </ol>
            </details>
          </li>
        ) : null}
      </LedgerSection>
      {confirmDialog}
    </>
  )
}

/** The secondary line: the title, then the companies, whichever exist. */
function contactMeta(c: SpaceContact): string {
  return [c.headline, c.companies].filter(Boolean).join(' · ')
}

/**
 * One tagged contact. The row links to the person; the X removes the tag and
 * nothing else, which is why the confirm says the record stays.
 */
function ContactRow({
  contact,
  onUntag,
}: {
  contact: SpaceContact
  onUntag: () => void
}) {
  const meta = contactMeta(contact)
  return (
    <LedgerRow className="group">
      <Link
        to="/people/$personId"
        params={{ personId: contact.id }}
        className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone"
      >
        <InitialsMark name={contact.name} outline />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">
          {contact.name}
        </span>
        <span className="min-w-0 shrink truncate text-right mono text-micro text-graphite max-md:hidden">
          {meta}
        </span>
      </Link>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${contact.name}`}
        onClick={onUntag}
        className="shrink-0 text-graphite opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
      >
        <X />
      </Button>
    </LedgerRow>
  )
}

/**
 * One inherited contact. The same row as a tagged one with two differences,
 * and both are the point:
 *
 * - it names the company it came in on, and that name is the link to the
 *   company's record — a row on this page nobody tagged here has to say
 *   where it came from;
 * - **there is no remove.** Removing is an untag and this person is not
 *   tagged here; the control belongs on the company's record, where the
 *   `contact_at` edge that put them on screen actually lives.
 */
function InheritedContactRow({ contact }: { contact: InheritedContact }) {
  // One route table for the whole app. A company always has a page, so the
  // null arm is unreachable — and rendering the name unlinked rather than
  // `<Link to={undefined}>` is what keeps it unreachable *and* harmless.
  const href = recordPath({ kind: 'company', id: contact.companyId })

  return (
    <LedgerRow>
      <Link
        to="/people/$personId"
        params={{ personId: contact.id }}
        className="focus-ring-inset flex h-full min-w-0 flex-1 items-center gap-3 transition-colors hover:bg-bone"
      >
        <InitialsMark name={contact.name} outline />
        <span className="min-w-0 flex-1 truncate text-ui">{contact.name}</span>
        {contact.headline ? (
          <span className="min-w-0 shrink truncate text-right mono text-micro text-graphite max-md:hidden">
            {contact.headline}
          </span>
        ) : null}
      </Link>
      <span className="w-40 shrink-0 truncate text-right mono text-micro text-graphite">
        {href ? (
          <Link to={href} className="focus-ring text-primary hover:underline">
            {contact.companyName}
          </Link>
        ) : (
          contact.companyName
        )}
      </span>
    </LedgerRow>
  )
}
