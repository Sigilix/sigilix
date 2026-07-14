import { describe, expect, it } from "vitest"

import { makeD1 } from "./d1-sqlite-shim"

describe("D1DatabaseShim.batch", () => {
  it("rolls back earlier writes when a later statement fails", async () => {
    const db = makeD1()
    await db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO entries (id, label) VALUES (?, ?)")

    await expect(db.batch([insert.bind(1, "first"), insert.bind(1, "duplicate")])).rejects.toThrow(
      /UNIQUE constraint failed/,
    )

    const row = await db.prepare("SELECT COUNT(*) AS count FROM entries").first<{ count: number }>()
    expect(row?.count).toBe(0)
  })

  it("commits successful writes and preserves ordered SELECT results", async () => {
    const db = makeD1()
    await db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
    const insert = db.prepare("INSERT INTO entries (id, label) VALUES (?, ?)")

    const results = await db.batch<{ id: number; label: string }>([
      insert.bind(1, "first"),
      insert.bind(2, "second"),
      db.prepare("SELECT id, label FROM entries ORDER BY id"),
    ])

    expect(results[0]?.meta.changes).toBe(1)
    expect(results[1]?.meta.changes).toBe(1)
    expect(results[2]?.results).toEqual([
      { id: 1, label: "first" },
      { id: 2, label: "second" },
    ])

    const persisted = await db.prepare("SELECT id, label FROM entries ORDER BY id").all<{
      id: number
      label: string
    }>()
    expect(persisted.results).toEqual(results[2]?.results)
  })
})

describe("D1DatabaseShim.withSession", () => {
  it("advances an opaque bookmark and accepts it as the next session anchor", async () => {
    const db = makeD1()
    await db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")

    const first = db.withSession("first-primary")
    expect(first.getBookmark()).toBeNull()
    await first.prepare("INSERT INTO entries (id, label) VALUES (?, ?)").bind(1, "first").run()
    const bookmark = first.getBookmark()
    expect(bookmark).toEqual(expect.any(String))

    const resumed = db.withSession(bookmark ?? undefined)
    expect(resumed.getBookmark()).toBe(bookmark)
    await expect(resumed.prepare("SELECT label FROM entries WHERE id = 1").first("label")).resolves.toBe("first")
    expect(resumed.getBookmark()).not.toBe(bookmark)
  })

  it("keeps batch writes atomic when issued through a session", async () => {
    const db = makeD1()
    await db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, label TEXT NOT NULL)")
    const session = db.withSession("first-primary")
    const insert = session.prepare("INSERT INTO entries (id, label) VALUES (?, ?)")

    await expect(session.batch([insert.bind(1, "first"), insert.bind(1, "duplicate")])).rejects.toThrow(
      /UNIQUE constraint failed/,
    )
    await expect(db.prepare("SELECT COUNT(*) AS count FROM entries").first("count")).resolves.toBe(0)
  })
})
