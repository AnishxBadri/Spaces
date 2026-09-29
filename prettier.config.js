//  @ts-check

// The formatter configuration lives in packages/config (SPA-180); prettier
// walks up from each file and finds it here, so the pre-commit hook, CI's
// `prettier --check .` and every editor read the same settings from the root.
export { default } from '@spaces/config/prettier'
