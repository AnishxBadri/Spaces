/**
 * Server functions consumed by route loaders and forms. Auth checks happen
 * here — never trust the client to have done them. The implementations live
 * in src/lib/server/, one file per domain (companies, attributes, people,
 * deals, interactions, documents, timeline, dedupe, notes, search, glossary,
 * spaces, settings); private helpers shared across domains sit in
 * src/lib/server/shared.ts. This barrel re-exports everything so call sites
 * keep importing from '#/lib/server-fns'.
 */

export * from './server/settings'
export * from './server/members'
export * from './server/mandate'
export * from './server/templates'
export * from './server/companies'
export * from './server/attributes'
export * from './server/people'
export * from './server/deals'
export * from './server/interactions'
export * from './server/documents'
export * from './server/timeline'
export * from './server/dedupe'
export * from './server/notes'
export * from './server/search'
export * from './server/glossary'
export * from './server/spaces'
export * from './server/portfolio'
