/**
 * The identity-key normalizers live in `@spaces/sdk/identity` since SPA-195
 * (sdk-4b): a plugin must normalize a claim's keys exactly as `resolveEntity`
 * does, and a plugin imports only the SDK. This path stays so every
 * `@spaces/core/entities/normalize` importer is unchanged.
 */
export * from '@spaces/sdk/identity'
