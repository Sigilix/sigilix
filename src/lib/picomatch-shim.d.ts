// SIG-172: minimal type declarations for `picomatch/posix`.
//
// picomatch v4 ships without bundled .d.ts files and `@types/picomatch`
// is published only for v2. The posix submodule (`picomatch/posix`) is
// the Workers-safe entry point per the SIG-172 research: the default
// entry imports Node `path` historically, and even if v4 no longer does,
// using the posix submodule documents intent + future-proofs the import.
//
// Surface declared is the minimal subset Sigilix actually uses
// (a matcher factory returning a string predicate). Extend only as
// the call surface grows.

declare module "picomatch/posix" {
  interface PicomatchOptions {
    nocase?: boolean
    dot?: boolean
  }

  /** Predicate produced by `picomatch(pattern)`. Returns `true` when
   *  `path` matches the compiled glob. */
  type Matcher = (path: string) => boolean

  function picomatch(pattern: string, options?: PicomatchOptions): Matcher

  export default picomatch
  export type { Matcher, PicomatchOptions }
}
