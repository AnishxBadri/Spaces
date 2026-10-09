/**
 * @spaces/sdk — what a plugin imports (docs/spec-plugin-sdk.md §3–§6): the
 * manifest, the version check and `definePlugin` (sdk-3); the frozen
 * contract — port names, claims, trigger shapes, the cost hook, job errors
 * (sdk-4a, `contract.ts`); the port tags (sdk-5, `ports.ts`); the
 * storage-source provider interface (`storage-source.ts`). The testing kit
 * is `@spaces/sdk/testing`.
 */
export { SDK_VERSION } from './version.ts'
export { satisfiesSdk, parseSdkRange, isVersion } from './range.ts'
export type { SdkCheck } from './range.ts'
export {
  TRIGGERS,
  ACTION_TARGETS,
  STORAGE_SOURCE_WITHHELD,
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
export type {
  Plugin,
  PluginJobs,
  LifecycleHook,
  StorageSourceProvider,
  StorageSourceMember,
} from './plugin.ts'
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
  ImportCell,
  ImportRow,
  ImportGrid,
  FactValues,
  FactClaim,
  AnswerClaim,
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
  WebhookInput,
  WebhookJob,
  FileInput,
  FileJob,
  JobFor,
} from './contract.ts'
export {
  ENRICHMENT_VOCABULARY,
  VOCABULARY_KEYS,
  VOCABULARY_TYPES,
  isVocabularyKey,
  vocabularyProblem,
} from './vocabulary.ts'
export type {
  VocabularyEntry,
  VocabularyKey,
  VocabularyType,
} from './vocabulary.ts'
export {
  NotFound,
  CursorExpired,
  RateLimited,
  AuthExpired,
} from './storage-source.ts'
export type {
  StorageSource,
  StorageSourceError,
  LinkTarget,
  StorageEntry,
  FolderPage,
  ListFolderOptions,
  FolderRef,
  StorageFolder,
  StorageFile,
  StorageChange,
  ChangePage,
  PickerConfig,
} from './storage-source.ts'
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
  Import,
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
  AnswerResult,
  AiLane,
  AiItem,
  RecordKind,
  ReadEntity,
  SearchHit,
  SearchOptions,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  HttpStreamResponse,
  LogFields,
  ImportRefusal,
  StageResult,
} from './ports.ts'
