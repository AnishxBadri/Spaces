/**
 * `get_record` and `resolveEntityRef` moved into core with SPA-198 so the
 * plugin SDK's `Read.entity` is the same read; this keeps every existing
 * import (the MCP server, the rpc handlers, their tests) unchanged.
 */
export * from '@spaces/core/writes/read/record'
