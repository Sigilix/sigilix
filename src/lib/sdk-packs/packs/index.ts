// SIG-298 follow-on — the SDK guidance pack registry. Every pack the review
// pipeline can match against a PR's diff. Adding a vendor is: write
// `packs/<vendor>.ts`, add it here.

import { stripePack } from "./stripe"
import { nextjsPack } from "./nextjs"
import { openaiSdkPack } from "./openai-sdk"
import { anthropicSdkPack } from "./anthropic-sdk"
import { supabasePack } from "./supabase"
import { posthogPack } from "./posthog"
import type { SdkPack } from "@/src/lib/sdk-packs/types"

export const SDK_PACKS: readonly SdkPack[] = [
  stripePack,
  nextjsPack,
  openaiSdkPack,
  anthropicSdkPack,
  supabasePack,
  posthogPack,
]
