import { describe, expect, it } from "vitest"
import { validateGitHubRepositoryContextInput } from "./input"

const detectsCredential = (value: string) => /sk_(?:live|test)_[A-Za-z0-9]{24,}/.test(value)
const validate = (value: unknown) => validateGitHubRepositoryContextInput(value, detectsCredential)

function validInput() {
  return {
    revision: 0,
    repositories: [
      { repositoryId: 101, context: "  Public API service.\r\nOwns request validation.  " },
      { repositoryId: 202, context: "Background jobs" },
    ],
    relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "  publishes   jobs to  " }],
    conventions: "  Use conventional commits.\r\nRun tests before merge.  ",
  }
}

describe("validateGitHubRepositoryContextInput", () => {
  it("accepts only the closed GitHub contract and normalizes user-authored text", () => {
    expect(validate(validInput())).toEqual({
      ok: true,
      value: {
        expectedRevision: 0,
        repositories: [
          { externalId: "101", context: "Public API service.\nOwns request validation.", position: 0 },
          { externalId: "202", context: "Background jobs", position: 1 },
        ],
        relationships: [
          {
            fromExternalId: "101",
            toExternalId: "202",
            label: "publishes jobs to",
            normalizedLabel: "publishes jobs to",
            position: 0,
          },
        ],
        conventions: "Use conventional commits.\nRun tests before merge.",
      },
    })
  })

  it.each([
    { ...validInput(), provider: "github" },
    { ...validInput(), scopeId: "42" },
    { ...validInput(), installationId: 42 },
    { ...validInput(), extra: true },
    { ...validInput(), repositories: [{ repositoryId: 101, context: "ok", name: "attacker/repo" }] },
    {
      ...validInput(),
      relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "uses", extra: true }],
    },
  ])("rejects unknown keys so the body cannot supply provider, scope, or repository names", (input) => {
    expect(validate(input)).toMatchObject({ ok: false, reason: "invalid_shape" })
  })

  it.each([NaN, -1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected revisions: %s",
    (revision) => {
      expect(validate({ ...validInput(), revision })).toMatchObject({
        ok: false,
        reason: "invalid_revision",
      })
    },
  )

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "101", "01"])(
    "rejects non-canonical immutable GitHub repository ids: %s",
    (id) => {
      expect(
        validate({
          ...validInput(),
          repositories: [{ repositoryId: id, context: "service" }],
          relationships: [],
        }),
      ).toMatchObject({ ok: false, reason: "invalid_repository" })
    },
  )

  it("rejects duplicate repositories, missing endpoints, self edges, and duplicate normalized directed edges", () => {
    const duplicateRepos = {
      ...validInput(),
      repositories: [
        { repositoryId: 101, context: "a" },
        { repositoryId: 101, context: "b" },
      ],
    }
    expect(validate(duplicateRepos)).toMatchObject({
      ok: false,
      reason: "duplicate_repository",
    })

    for (const relationships of [
      [{ fromRepositoryId: 101, toRepositoryId: 303, label: "uses" }],
      [{ fromRepositoryId: 101, toRepositoryId: 101, label: "uses" }],
    ]) {
      expect(validate({ ...validInput(), relationships })).toMatchObject({
        ok: false,
        reason: "invalid_relationship",
      })
    }

    expect(
      validate({
        ...validInput(),
        relationships: [
          { fromRepositoryId: 101, toRepositoryId: 202, label: "Publishes   Jobs" },
          { fromRepositoryId: 101, toRepositoryId: 202, label: " publishes jobs " },
        ],
      }),
    ).toMatchObject({ ok: false, reason: "duplicate_relationship" })
  })

  it("enforces repository, relationship, and text caps", () => {
    expect(
      validate({
        ...validInput(),
        repositories: Array.from({ length: 101 }, (_, index) => ({ repositoryId: index + 1, context: "" })),
        relationships: [],
      }),
    ).toMatchObject({ ok: false, reason: "too_many_repositories" })

    expect(
      validate({
        ...validInput(),
        relationships: Array.from({ length: 201 }, (_, index) => ({
          fromRepositoryId: 101,
          toRepositoryId: 202,
          label: `edge ${index}`,
        })),
      }),
    ).toMatchObject({ ok: false, reason: "too_many_relationships" })

    expect(
      validate({
        ...validInput(),
        repositories: [{ repositoryId: 101, context: "x".repeat(2001) }],
        relationships: [],
      }),
    ).toMatchObject({ ok: false, reason: "repository_context_too_large" })
    expect(
      validate({
        ...validInput(),
        relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "x".repeat(201) }],
      }),
    ).toMatchObject({ ok: false, reason: "relationship_label_too_large" })
    expect(validate({ ...validInput(), conventions: "x".repeat(4001) })).toMatchObject({
      ok: false,
      reason: "conventions_too_large",
    })
    expect(
      validate({
        ...validInput(),
        relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "İ".repeat(200) }],
      }),
    ).toMatchObject({ ok: false, reason: "relationship_label_too_large" })
  })

  it("canonicalizes repository and relationship order independently of request order", () => {
    const input = {
      revision: 7,
      repositories: [
        { repositoryId: 303, context: "three" },
        { repositoryId: 101, context: "one" },
        { repositoryId: 202, context: "two" },
      ],
      relationships: [
        { fromRepositoryId: 101, toRepositoryId: 202, label: "ä" },
        { fromRepositoryId: 202, toRepositoryId: 303, label: "later endpoint" },
        { fromRepositoryId: 101, toRepositoryId: 202, label: "z" },
      ],
      conventions: "stable",
    }
    const first = validate(input)
    const second = validate({
      ...input,
      repositories: [...input.repositories].reverse(),
      relationships: [...input.relationships].reverse(),
    })
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      ok: true,
      value: {
        repositories: [{ externalId: "101" }, { externalId: "202" }, { externalId: "303" }],
        relationships: [
          { fromExternalId: "101", toExternalId: "202", normalizedLabel: "z", position: 0 },
          { fromExternalId: "101", toExternalId: "202", normalizedLabel: "ä", position: 1 },
          { fromExternalId: "202", toExternalId: "303", position: 2 },
        ],
      },
    })
  })

  it("rejects credentials in both original and Unicode-normalized user text", () => {
    const stripe = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"
    expect(
      validate({
        ...validInput(),
        repositories: [{ repositoryId: 101, context: `Deploy with ${stripe}` }],
        relationships: [],
      }),
    ).toMatchObject({ ok: false, reason: "credential_detected" })

    const normalizedOnly = "ｓｋ＿ｌｉｖｅ＿４ｅＣ３９ＨｑＬｙｊＷＤａｒｊｔＴ１ｚｄｐ７ｄｃ"
    expect(validate({ ...validInput(), conventions: normalizedOnly })).toMatchObject({
      ok: false,
      reason: "credential_detected",
    })
  })

  it("accepts empty context and ordinary non-secret guidance", () => {
    expect(
      validate({
        revision: 3,
        repositories: [{ repositoryId: 101, context: "" }],
        relationships: [],
        conventions: "Prefer focused pull requests and SHA-256 checksums.",
      }),
    ).toMatchObject({ ok: true })
  })

  it("rejects NUL and other C0 controls before SQLite length checks while allowing multiline text", () => {
    expect(
      validate({
        ...validInput(),
        repositories: [{ repositoryId: 101, context: "safe\u0000" }],
        relationships: [],
      }),
    ).toMatchObject({ ok: false, reason: "invalid_text" })
    expect(
      validate({
        ...validInput(),
        relationships: [{ fromRepositoryId: 101, toRepositoryId: 202, label: "uses\tservice" }],
      }),
    ).toMatchObject({ ok: false, reason: "invalid_text" })
    expect(validate(validInput())).toMatchObject({ ok: true })
  })

  it("rejects ill-formed Unicode before normalization and hashing", () => {
    for (const context of ["lone high \ud800", "lone low \udfff"]) {
      expect(
        validate({
          ...validInput(),
          repositories: [{ repositoryId: 101, context }],
          relationships: [],
        }),
      ).toMatchObject({ ok: false, reason: "invalid_text" })
    }
    expect(
      validate({
        ...validInput(),
        repositories: [{ repositoryId: 101, context: "valid pair \ud83d\ude80" }],
        relationships: [],
      }),
    ).toMatchObject({ ok: true })
  })
})
