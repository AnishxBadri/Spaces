import type {
  AskCall,
  AskCallCard,
  AskCardKind,
  AskFindRow,
  AskFindStanding,
  AskFindTable,
  AskRef,
  AskScopeChip,
  AskTurnState,
  AskVia,
} from '@spaces/db/schema/ask'
import type { AskCardView } from './cards'

export type {
  AskCall,
  AskCallCard,
  AskCardKind,
  AskCardView,
  AskFindRow,
  AskFindStanding,
  AskFindTable,
  AskRef,
  AskScopeChip,
  AskTurnState,
  AskVia,
}

/**
 * What Ask's surfaces read: a thread, its turns, and the events a turn
 * streams. Plain data, so it crosses the server-fn seam and both the dock
 * and `/ask` draw from it. (D70)
 */

export type AskTurnView = {
  id: string
  role: 'user' | 'assistant'
  /** The question, or the answer with `[ref]` citations; empty when hidden. */
  body: string
  refs: ReadonlyArray<AskRef>
  calls: ReadonlyArray<AskCall>
  /** The action cards the answer proposed; empty when hidden. */
  cards: ReadonlyArray<AskCardView>
  scope: ReadonlyArray<AskScopeChip>
  state: AskTurnState | null
  /** The model line, or the refusal. */
  route: string | null
  savedAt: string | null
  createdAt: string
  /** The answer cited something the reader can no longer see. */
  hidden: boolean
}

export type AskThreadView = {
  id: string
  title: string
  createdAt: string
  turns: ReadonlyArray<AskTurnView>
}

/** A row of `/ask`'s thread list. */
export type AskThreadRow = {
  id: string
  title: string
  createdAt: string
  /** The scope the thread was first asked in; empty is the workspace. */
  scope: ReadonlyArray<AskScopeChip>
  questions: number
  /** Proposals from its turns accepted in Review. */
  applied: number
  /** Answers saved as notes. */
  saved: number
}

/** One event of a streaming turn. */
export type AskEvent =
  /** The rows exist: the thread and the two turns. */
  | {
      type: 'turn'
      threadId: string
      title: string
      question: AskTurnView
      answerId: string
    }
  /** A model was chosen; text streamed before it is dropped. */
  | { type: 'route'; line: string; sensitive: boolean }
  | { type: 'call'; id: string; call: AskCall }
  /** A card proposed, not yet stored: it is stored with an answered turn. */
  | { type: 'card'; card: AskCardView }
  | { type: 'text'; text: string }
  /** The answer as stored: final state, refs and foot. */
  | { type: 'end'; turn: AskTurnView }

/** How a scope chip is told apart from another. */
export const scopeKey = (scope: ReadonlyArray<AskScopeChip>): string =>
  scope.map((c) => `${c.kind}:${c.id ?? ''}`).join('|')

/** The words a scope reads as in the thread's divider and list. */
export const scopeWords = (scope: ReadonlyArray<AskScopeChip>): string =>
  scope.length === 0 ? 'Whole workspace' : scope.map((c) => c.name).join(' · ')
