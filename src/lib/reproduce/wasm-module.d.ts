// SIG-477 PR-2 — ambient declaration for a vendored `.wasm` import.
//
// On Cloudflare Workers, `import mod from "./file.wasm"` resolves to a compiled
// `WebAssembly.Module` natively (the wrangler/esbuild bundler treats `.wasm` as a
// module asset). TypeScript doesn't know that shape out of the box and neither
// `@cloudflare/workers-types` nor the default lib declares it, so we declare it
// here. Scoped to the relative spec the sandbox runner uses; intentionally narrow
// so it can't silently change the type of an unrelated import elsewhere.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module
  export default wasmModule
}
