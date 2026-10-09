export type Skeleton = { ok: boolean }

declare module 'claude-code' {
  interface PluginState {
    watchducks: { skeleton: Skeleton }
  }
}
