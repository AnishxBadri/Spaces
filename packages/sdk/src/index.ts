/**
 * @spaces/sdk — what a plugin imports (docs/spec-plugin-sdk.md §3–§6): the
 * manifest, the version check and `definePlugin` (sdk-3); the frozen
 * contract — port names, claims, trigger shapes, the cost hook, job errors
 * (sdk-4a, `contract.ts`); the port tags (sdk-5, `ports.ts`). The testing
 * kit is `@spaces/sdk/testing`.
 */
export { SDK_VERSION } from './version.ts'
export { satisfiesSdk, parseSdkRange, isVersion } from './range.ts'
export type { SdkCheck } from './range.ts'
export {
  TRIGGERS,
  ACTION_TARGETS,
  manifestSchema,
  defineManifest,
  toManifestJson,
  settingsJsonSchema,
} from './manifest.ts'
export type {
  Trigger,
  Manifest,
  JobDeclaration,
  AuthoredJob,
  AuthoredManifest,
} from './manifest.ts'
export { definePlugin } from './plugin.ts'
export type { Plugin, PluginJobs, LifecycleHook } from './plugin.ts'
export {
  PORT_NAMES,
  DOCUMENT_KINDS,
  DOMAIN_EVENTS,
  JobRetryable,
  JobRateLimited,
  JobPermanent,
} from './contract.ts'
export type {
  JsonValue,
  JsonObject,
  EntityId,
  IsoTimestamp,
  Ref,
  PortName,
  IdentityKind,
  IdentityKeys,
  IdentityClaim,
  AliasClaim,
  FactValues,
  FactClaim,
  ReceiptClaim,
  DocumentKind,
  FilingTarget,
  DocumentBytes,
  DocumentClaim,
  InteractionKind,
  InteractionClaim,
  SignalClaim,
  ContentClaim,
  NoteProposal,
  AttributeProposal,
  Proposal,
  JudgmentClaim,
  JobError,
  DomainEventName,
  DomainEvent,
  ActionInput,
  ActionRun,
  CostInput,
  CostHook,
  ActionJob,
  ScheduleInput,
  ScheduleOutput,
  ScheduleJob,
  EventInput,
  EventJob,
  WebhookRequest,
  WebhookInput,
  WebhookJob,
  FileInput,
  FileJob,
  JobFor,
} from './contract.ts'
export type { StorageSource } from './storage-source.ts'
export {
  Identity,
  Facts,
  Content,
  Judgment,
  Receipts,
  Ai,
  Read,
  Secrets,
  Config,
  PluginDb,
  Http,
  Log,
  PORTS,
  NotConnected,
  configOf,
  responseJson,
} from './ports.ts'
export type {
  PortService,
  PortServices,
  ResolveOutcome,
  ResolveResult,
  AliasOutcome,
  AliasResult,
  FactConflict,
  FillResult,
  AiLane,
  AiItem,
  RecordKind,
  ReadEntity,
  SearchHit,
  SearchOptions,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  LogFields,
} from './ports.ts'
