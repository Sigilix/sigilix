// SIG-317 Part 3 — cents-rendered-as-dollars detector. ZERO P0/P1 FP bar, so
// every SKIP test is a precision guard. The headline FP trap (dual-design by
// DeepSeek + Kimi) is the currency `$` vs the template-literal `${` interpolation
// marker — the template tests pin that down.

import { describe, it, expect } from "vitest"
import { scanCentsRenderedAsDollars as scan } from "../src/lib/ast-rules/scan-cents-as-dollars"

describe("scanCentsRenderedAsDollars — FLAGS the bug", () => {
  it("flags the pr/11 D9 case: ${sub.monthlyCents} in JSX", () => {
    const hits = scan(`<h2>{sub.plan} — \${sub.monthlyCents}/mo</h2>`)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.message).toContain("monthlyCents")
  })

  it("flags the pr/10 D4 case: ${wallet.balanceCents} in JSX", () => {
    expect(scan(`<span>Balance: \${wallet.balanceCents}</span>`)).toHaveLength(1)
  })

  it("flags a snake_case _cents field", () => {
    expect(scan(`<td>\${row.amount_cents}</td>`)).toHaveLength(1)
  })

  it("flags optional-chained access ${x?.priceCents}", () => {
    expect(scan(`<b>\${item?.priceCents}</b>`)).toHaveLength(1)
  })

  it("flags a TEMPLATE currency $${x.amountCents} (double-dollar)", () => {
    expect(scan("const s = `Total $${charge.amountCents}`;")).toHaveLength(1)
  })
})

describe("scanCentsRenderedAsDollars — SKIPS (precision guards)", () => {
  it("does NOT flag a plain template interpolation ${x.amountCents} — the $-vs-${ trap", () => {
    // single `$` interpolation inside backticks = the marker, NOT currency.
    expect(scan("const url = `/api/charge/${charge.amountCents}`;")).toHaveLength(0)
  })

  it("does NOT flag a formatter call ${formatUsd(x.amountCents)}", () => {
    expect(scan(`<td>\${formatUsd(inv.amountCents)}</td>`)).toHaveLength(0)
  })

  it("does NOT flag a non-$-prefixed JSX expression {formatUsd(inv.amountCents)}", () => {
    // no leading `$` → not a currency render at all (the real InvoiceTable control).
    expect(scan(`<td>{formatUsd(inv.amountCents)}</td>`)).toHaveLength(0)
  })

  it("does NOT flag an inline divide ${(x.amountCents / 100).toFixed(2)}", () => {
    expect(scan(`<span>\${(x.amountCents / 100).toFixed(2)}</span>`)).toHaveLength(0)
  })

  it("does NOT flag the formatUsd helper body `$${(cents / 100).toFixed(2)}`", () => {
    expect(scan("function f(c){ return `$${(c / 100).toFixed(2)}`; }")).toHaveLength(0)
  })

  it("does NOT flag a *0.01 conversion", () => {
    expect(scan(`<span>\${x.amountCents * 0.01}</span>`)).toHaveLength(0)
  })

  it("does NOT flag a non-cents field ${sub.seat_count}", () => {
    expect(scan(`<p>\${sub.seat_count} seats</p>`)).toHaveLength(0)
  })

  it("does NOT flag an English word ending in lowercase 'cents' (accents)", () => {
    expect(scan(`<p>\${theme.accents}</p>`)).toHaveLength(0)
  })

  it("does NOT flag any call wrapping (could be a converter) ${toMoney(x.amountCents)}", () => {
    expect(scan(`<b>\${toMoney(x.amountCents)}</b>`)).toHaveLength(0)
  })

  it("does NOT flag a $ inside a string literal", () => {
    expect(scan(`const label = "$\${x.amountCents}";`)).toHaveLength(0)
  })

  it("does NOT flag a $ inside a comment", () => {
    expect(scan(`// old: <span>\${x.amountCents}</span>`)).toHaveLength(0)
  })

  it("does NOT flag cents used in math (no $ render)", () => {
    expect(scan(`const total = a.amountCents + b.taxCents;`)).toHaveLength(0)
  })

  // FP vectors caught by the dual review (code-reviewer + DeepSeek).
  it("does NOT flag a regex literal containing ${...Cents...} (review HIGH)", () => {
    expect(scan(`const RX = /\\$\{(\\w+)Cents}/g;`)).toHaveLength(0)
    expect(scan(`tpl.replace(/\\$\{x.amountCents}/, '0')`)).toHaveLength(0)
  })

  it("does NOT flag a divide by a non-100 constant (review HIGH — any scaling skips)", () => {
    expect(scan(`<span>\${order.amountCents / 1000}</span>`)).toHaveLength(0)
    expect(scan(`<span>\${x.amountCents * 2}</span>`)).toHaveLength(0)
  })

  it("does NOT flag 'Cents' appearing inside a STRING within the expr (DeepSeek)", () => {
    // the `}` inside the string must not close the brace early, and the string
    // body must not be tested for the Cents identifier.
    expect(scan(`<div>\${ {"Cents}": 1} }</div>`)).toHaveLength(0)
    expect(scan("<div>${`Cents}`}</div>")).toHaveLength(0)
  })

  it("does NOT flag inside a nested template (lexer nesting)", () => {
    expect(scan("const s = `a${`b${charge.amountCents}`}`;")).toHaveLength(0)
  })

  it("does NOT flag a template interpolation opened on a PRIOR line", () => {
    expect(scan("const s = `line one\nand ${charge.amountCents} more`;")).toHaveLength(0)
  })

  it("flags a double-dollar currency inside a nested template", () => {
    expect(scan("const s = `outer ${`inner $${charge.amountCents}`}`;")).toHaveLength(1)
  })

  it("does NOT flag a regex literal after a control-flow ) — `if (ok) /…/` (CodeRabbit #306)", () => {
    expect(scan(`if (ok) /\\$\{x.amountCents}/.test(s);`)).toHaveLength(0)
    expect(scan(`while (go) /\\$\{y.priceCents}/g.exec(s);`)).toHaveLength(0)
  })

  it("treats `/` after a value-`)` as division so a later cents render still flags (CodeRabbit #306)", () => {
    // if `(a + b) / 100` were misread as a regex start, the "regex" would run to
    // the next `/` and mask the ${order.amountCents} → 0 hits. Correct = 1 hit.
    const src = `const x = (a + b) / 100; return <span>\${order.amountCents}</span>;`
    expect(scan(src)).toHaveLength(1)
  })

  it("does NOT flag a regex after `if /* c */ (ok)` — comment between keyword and paren (CodeRabbit #306)", () => {
    expect(scan(`if /* c */ (ok) /\\$\{x.amountCents}/.test(s);`)).toHaveLength(0)
  })
})

describe("scanCentsRenderedAsDollars — structure (endLine)", () => {
  it("carries endLine for a multi-line currency render (CodeRabbit #306)", () => {
    const src = `<h2>\${\n  sub.monthlyCents\n}</h2>`
    const hits = scan(src)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(1)
    expect(hits[0]!.endLine).toBe(3)
  })
})

describe("scanCentsRenderedAsDollars — structure", () => {
  it("reports the correct line", () => {
    const src = `line1\nline2\n<h2>\${sub.monthlyCents}</h2>`
    expect(scan(src)[0]!.line).toBe(3)
  })

  it("flags each distinct currency render once", () => {
    const src = `<div>\${a.amountCents} and \${b.priceCents}</div>`
    expect(scan(src)).toHaveLength(2)
  })

  it("is a no-op on source with no $", () => {
    expect(scan(`<p>{x.amountCents}</p>`)).toHaveLength(0)
  })
})
