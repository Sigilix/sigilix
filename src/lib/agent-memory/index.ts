// Agent-memory store — public barrel (COMPLIANCE.md §2). The feature's public
// surface is the two route handlers + the public types; the KV storage,
// Vectorize/embedding, and parsing internals stay private.

export { handleMemoryWriteRoute, handleMemoryQueryRoute } from "./agent-memory-route"
export { handleMemoryExtractRoute } from "./agent-memory-extract"
export { handleMemoryListRoute, handleMemoryDeleteRoute, handleMemoryCreateRoute } from "./agent-memory-crud-route"
export { renderChatSurfaceMemoryForPrompt } from "./agent-memory-chat-surface"
export type { ChatSurfaceMemory } from "./agent-memory-chat-surface"
export type { AgentMemoryKind, AgentMemoryRecord, AgentMemoryQueryResult } from "./types"
