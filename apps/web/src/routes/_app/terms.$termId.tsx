import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import {
  DitherMark,
  RecordBody,
  RecordHeader,
} from '#/components/record/record-parts'
import {
  CoMentioned,
  CompaniesReached,
  TermMentions,
} from '#/components/term/term-parts'
import { getTermPage } from '#/lib/server-fns'

/**
 * A term's page — the concept node (SPA-75; CONTEXT.md → Glossary). The
 * record shape (design contract §3), as `deals_.$dealId.tsx` draws it: caps
 * mono crumb, serif name, a readout strip, the body left and the bone rail
 * right. There is no actions menu — nothing is filed, tagged or attached
 * into a term — and the term is edited where it is defined, in its space's
 * glossary.
 */
export const Route = createFileRoute('/_app/terms/$termId')({
  loader: async ({ params }) => {
    const page = await getTermPage({ data: { termId: params.termId } })
    if (!page) throw notFound()
    return page
  },
  component: TermPage,
})

function TermPage() {
  const { term, mentions, companies, coMentioned } = Route.useLoaderData()

  return (
    <div className="flex min-h-full flex-col">
      <RecordHeader
        crumb={
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
        }
        mark={<DitherMark />}
        name={term.name}
        readouts={[
          {
            label: 'Also',
            value: term.aliases.length > 0 ? term.aliases.join(' · ') : '—',
            kind: 'text',
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
