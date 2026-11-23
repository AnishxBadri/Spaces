import { Option, Schema } from 'effect'
import { uuidString } from '@spaces/core/attributes/registry'
import { PROVIDER_TABS } from '#/lib/connections/provider-view'
import { EMAIL_TABS, THREAD_FILTERS } from '#/lib/email/threads'
import { MEETING_FILTERS } from '#/lib/meetings/list'
import { composeSearchShape, modalSearchShape } from '#/lib/modal-search'
import { caught, fallback, searchValidator } from '#/lib/search-validator'

/**
 * The searches of the routes that keep no schema of their own module. A
 * route file may not import Effect, so its `validateSearch` is built here.
 * Where a key is caught, a hand-typed bad value lands on the page rather
 * than an error boundary; an uncaught bad value is refused.
 */

const ListSearch = Schema.Struct({ view: Schema.optional(Schema.String) })

/** An object list's `?view=`: the saved view it opens on. */
export const listSearch = searchValidator(ListSearch)

const decodeView = Schema.decodeUnknownOption(
  Schema.Struct({ view: Schema.String }),
)

/** A location's `?view=`, read without trusting its type; else null. */
export function listViewOf(search: unknown): string | null {
  return Option.match(decodeView(search), {
    onNone: () => null,
    onSome: ({ view }) => view,
  })
}

/** `/ask?thread=`: the thread read full width. */
export const askSearch = searchValidator(
  Schema.Struct({ thread: caught(uuidString) }),
)

/** `/import?object=`: the object the wizard has picked already. */
export const importSearch = searchValidator(
  Schema.Struct({
    object: Schema.optional(Schema.String.check(Schema.isMaxLength(80))),
  }),
)

/** An import batch's ledger filter (`show`) and step 4's (`outcome`). */
export const importBatchSearch = searchValidator(
  Schema.Struct({
    show: fallback(
      Schema.Literals(['all', 'create', 'attach', 'decide', 'noland']),
      'all',
    ),
    /** Step 4's filter: every row, or the ones that failed. */
    outcome: fallback(Schema.Literals(['all', 'failed']), 'all'),
  }),
)

/** `/meetings`: the list's filter and the window it opens. */
export const meetingsSearch = searchValidator(
  Schema.Struct({
    ...modalSearchShape,
    show: caught(Schema.Literals(MEETING_FILTERS)),
  }),
)

/**
 * `/email`: the tab, the thread or draft open in the pane (by the newest
 * message's id, or the draft's), Threads' filter and its search, and a new
 * email's window over the page (`modal=email&new=1&draft=`).
 */
export const emailSearch = searchValidator(
  Schema.Struct({
    modal: caught(Schema.Literals(['email'])),
    ...composeSearchShape,
    tab: caught(Schema.Literals(EMAIL_TABS)),
    id: caught(uuidString),
    filter: caught(Schema.Literals(THREAD_FILTERS)),
    q: caught(Schema.String.check(Schema.isMaxLength(200))),
  }),
)

/** `/review`: the record, source and space it is scoped to, and its lane. */
export const reviewSearch = searchValidator(
  Schema.Struct({
    record: caught(uuidString),
    source: caught(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    ),
    space: caught(uuidString),
    lane: caught(Schema.Literals(['all', 'suggestions', 'duplicates'])),
  }),
)

/** A provider page's tab. */
export const providerSearch = searchValidator(
  Schema.Struct({ tab: Schema.optional(Schema.Literals(PROVIDER_TABS)) }),
)

/** `/settings/members?invite=true` opens the Invite window. */
export const membersSearch = searchValidator(
  Schema.Struct({ invite: caught(Schema.Boolean) }),
)

/** `/settings/usage`: one run's detail, or one integration's runs. */
export const usageSearch = searchValidator(
  Schema.Struct({
    run: Schema.optional(uuidString),
    integration: Schema.optional(uuidString),
  }),
)

/** `/tasks`: the row a hit lands on, and the record the list narrows to. */
export const tasksSearch = searchValidator(
  Schema.Struct({ task: caught(uuidString), record: caught(uuidString) }),
)

/** `/join` and `/reset`: the raw token the link carries; none reads as `''`. */
export const tokenSearch = searchValidator(
  Schema.Struct({ token: fallback(Schema.String, '') }),
)

/** `/login`: where the reader came from (`reset=done`, `from=setup`). */
export const loginSearch = searchValidator(
  Schema.Struct({
    reset: Schema.optional(Schema.String),
    from: Schema.optional(Schema.String),
  }),
)
