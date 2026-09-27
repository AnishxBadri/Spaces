import { useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { readOptionProposals } from '@spaces/core/ai/attribute-ai'
import type { OptionProposal } from '@spaces/core/ai/attribute-ai'
import { Button } from '#/components/ui/button'
import { addProposedOption } from '#/lib/server-fns'

/**
 * A registry proposal (SPA-72): an AI attribute's classify run wanted an
 * option the attribute does not have. It is never a value and never a
 * silent new option — the suggestion's patch is empty and its rationale
 * names the option (`optionProposalLine`). This body says so and offers the
 * one explicit write: "Add option", which goes through the attribute's own
 * option-list edit (`updateAttribute`, admin-owned) and then closes the
 * proposal as accepted. Running the cell again is what may then propose the
 * new option as the value.
 */

export function OptionProposalBody({
  suggestionId,
  rationale,
}: {
  suggestionId: string
  rationale: string | null
}) {
  const proposals = readOptionProposals(rationale)
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function add(p: OptionProposal) {
    setPending(true)
    try {
      const r = await addProposedOption({
        data: { suggestionId, label: p.label },
      })
      toast(
        r.added
          ? `"${r.label}" added to ${r.attribute} · run the cell again to propose it`
          : `${r.attribute} already has "${r.label}" · proposal closed`,
      )
      void router.invalidate()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add option')
    } finally {
      setPending(false)
    }
  }

  return (
    <dl className="flex min-w-0 flex-col gap-2">
      {proposals.map((p) => (
        <div
          key={`${p.slug}:${p.label}`}
          className="flex min-w-0 flex-col gap-1"
        >
          <dt className="truncate field-label text-graphite">
            New option for {p.name}
          </dt>
          <dd className="min-w-0 truncate text-ui" title={p.label}>
            {p.label}
          </dd>
          <dd>
            <Button
              size="xs"
              variant="outline"
              disabled={pending}
              title={`Add "${p.label}" to ${p.name}'s options — a registry change, for everyone`}
              onClick={() => void add(p)}
            >
              <Plus className="size-3" strokeWidth={2} />
              Add option “{p.label}” to {p.name}
            </Button>
          </dd>
        </div>
      ))}
    </dl>
  )
}
