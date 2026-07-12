// Bedrock-ensemble migration — the SigV4 signer was EXTRACTED VERBATIM to
// `src/shared/adapters/aws-sigv4.ts` (COMPLIANCE.md §1: a shared foundation the
// ensemble's Bedrock model adapter also needs must live in `shared/`, never be
// reached via a `shared → lib` edge). This shim re-exports the full public
// surface so this gateway's importers (`./bedrock-chat.ts`) are unchanged.
export { signAwsRequestV4, type SignAwsRequestArgs, type SignedAwsRequest } from "@/src/shared/adapters/aws-sigv4"
