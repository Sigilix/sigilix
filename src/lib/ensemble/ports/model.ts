// Port: the ensemble's import surface for the model + embedding seams. The model
// provider is cross-cutting infra (SIG-381) defined in `@/shared/ports`; the
// ensemble depends on that shared port, and this file just re-exports it so
// ensemble consumers have a single `@/lib/ensemble/ports` surface. Types only.

export type {
  ModelProviderPort,
  GenerateArgs,
  GenerateResult,
  ChatArgs,
  ChatResult,
  ChatMessage,
  ChatToolDef,
  ToolCall,
  LlmUsage,
} from "@/shared/ports/model"

export type { EmbeddingPort, AiBinding } from "@/shared/ports/embedding"
