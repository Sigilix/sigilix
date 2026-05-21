// SIG-129 canary — throwaway file to verify branch-aware retrieval fires in
// prod. NOT FOR MERGE (this PR will be closed). The exported symbol below
// exists ONLY on this branch, so branch-aware retrieval should surface it
// during review — proving the acceptance criterion end-to-end.
export function canaryComputeWasteFactorXYZ(widthInches: number): number {
  return (widthInches * widthInches) / 144
}
