import {
  Link,
  createFileRoute,
  notFound,
  useNavigate,
} from '@tanstack/react-router'
import { toast } from 'sonner'
import {
  DitherMark,
  RecordBody,
  RecordHeadPending,
  RecordHeader,
} from '#/components/record/record-parts'
import { TermHeadActions } from '#/components/record/record-heads'
import {
  CoMentioned,
  CompaniesReached,
  TermMentions,
} from '#/components/term/term-parts'
import { createNote, getTermPage } from '#/lib/server-fns'

/**
 * A term's page — the concept node. The record shape: the stamp, the serif
 * name with its `Terms / <space>` path, Write a note and the `···`, the body
 * left and the bone rail right. Nothing is filed, tagged or attached into a
 * term, and the term is edited where it is defined, in its space's glossary.
 */
export const Route = createFileRoute('/_app/terms/$termId')({
  loader: async ({ params }) => {
    const page = await getTermPage({ data: { termId: params.termId } })
    if (!page) throw notFound()
    return page
  },
  pendingComponent: () => <RecordHeadPending kind="Term" />,
  component: TermPage,
})

function TermPage() {
  const { term, mentions, companies, coMentioned } = Route.useLoaderData()
  const navigate = useNavigate()

  /** A note that mentions the term: the first thing it gathers. */
  async function writeNote() {
    try {
      const { id } = await createNote({
        data: { about: { entityId: term.id, label: term.name, kind: 'term' } },
      })
      void navigate({ to: '/notes/$noteId', params: { noteId: id } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create note')
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        stamp={{ kind: 'Term' }}
        suffix={{
          path: (
            <>
              {'Terms / '}
              {term.space ? (
                <Link
                  to="/spaces/$spaceId"
                  params={{ spaceId: term.space.id }}
                  className="focus-ring hover:text-foreground"
                >
                  {term.space.name}
                </Link>
              ) : (
                'Workspace'
              )}
            </>
          ),
        }}
        actions={
          <TermHeadActions
            name={term.name}
            onWriteNote={() => void writeNote()}
          />
        }
        mark={<DitherMark />}
        name={term.name}
        readouts={[
          {
            label: 'Also',
            value: term.aliases.length > 0 ? term.aliases.join(' · ') : '—',
            tone: term.aliases.length > 0 ? undefined : 'muted',
          },
          { label: 'Mentions', value: `${mentions.total}` },
          { label: 'Companies reached', value: `${companies.total}` },
        ]}
      />

      <RecordBody
        rail={
          <>
            <CompaniesReached rows={companies.rows} total={companies.total} />
            <CoMentioned rows={coMentioned} />
          </>
        }
      >
        {/* The definition is the lead: someone wrote it, so it is serif. */}
        <p className="max-w-160 font-serif text-title">
          {term.definitionMd || (
            <span className="text-graphite">No definition yet.</span>
          )}
        </p>
        <TermMentions rows={mentions.rows} total={mentions.total} />
      </RecordBody>
    </div>
  )
}
