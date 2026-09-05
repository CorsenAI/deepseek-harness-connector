/**
 * Run the real page interface in a real browser, with nothing between the test and the module.
 *
 * `tests/e2e` drives the whole product through the extension, which is the right shape for most
 * questions but cannot see inside one action: it cannot count how many nodes a walk touched, and it
 * cannot instrument the page's own DOM interfaces, because the module runs in an isolated world the
 * test cannot reach. The findings this file guards — how much work a hostile document can cause,
 * and how large a result can grow — are exactly those questions.
 *
 * So the module here is the shipped `extension/src/page-actions.js`, imported by the page from the
 * repository over loopback, and the redaction configuration is the shipped `redact.js`. Nothing is
 * reimplemented; only the surroundings are simpler.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'

/** This file's directory, for locating the repository root. */
const here = dirname(fileURLToPath(import.meta.url))
/** The repository root, which is what the probe server serves. */
const root = resolvePath(join(here, '..', '..'))

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** One action's outcome, with what it cost. */
export interface ProbeResult {
  /** Exactly what `runPageAction` returned. */
  readonly result: {
    ok: boolean
    data?: Record<string, unknown>
    error?: { code: string, message: string }
  }
  /**
   * Filter invocations per tree walk the action created, in creation order.
   *
   * This is the measurement that distinguishes a budget that bounds the work from one that only
   * bounds the output: a walk that rejects nodes past its budget still visits every remaining node
   * before it ends.
   */
  readonly walkCalls: number[]
  /** The serialized size of the whole result, in bytes. */
  readonly bytes: number
}

/** A page with the real module loaded and a runner attached. */
export interface PageProbe {
  /**
   * Perform one action in the page.
   * @param kind - the action kind.
   * @param args - the action arguments.
   * @returns the outcome and its cost.
   */
  run: (kind: string, args?: Record<string, unknown>) => Promise<ProbeResult>
  /** The underlying page, for assertions about the document's own state. */
  readonly page: Page
}

/** The running probe environment: one browser, one server, many pages. */
export interface ProbeEnvironment {
  /**
   * Open a page holding the given document, with the module loaded.
   * @param html - the document body, served over loopback so module imports resolve.
   * @returns the probe.
   */
  open: (html: string) => Promise<PageProbe>
  /** Shut everything down. */
  close: () => Promise<void>
}

/**
 * Start a browser and a loopback server that serves the repository plus the test documents.
 * @returns the environment.
 */
export async function startProbes(): Promise<ProbeEnvironment> {
  const documents = new Map<string, string>()
  let nextDocument = 0

  const files: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/'
    const document = documents.get(path)
    if (document !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(document)
      return
    }
    // Only files inside the repository are served, so a stray path cannot read the filesystem.
    const target = normalize(join(root, decodeURIComponent(path)))
    if (!target.startsWith(root + sep)) {
      response.writeHead(403).end('outside the repository')
      return
    }
    try {
      response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream' })
      response.end(readFileSync(target))
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise<void>((resolve) => { files.listen(0, '127.0.0.1', () => { resolve() }) })
  const address = files.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const base = `http://127.0.0.1:${port}`

  const browser: Browser = await chromium.launch()

  return {
    open: async (html: string): Promise<PageProbe> => {
      nextDocument += 1
      const path = `/probe-${nextDocument}.html`
      documents.set(path, html)
      const page = await browser.newPage()
      await page.goto(`${base}${path}`)

      await page.evaluate(async () => {
        const actions = await import('/extension/src/page-actions.js')
        const redact = await import('/extension/src/redact.js')
        Object.assign(globalThis, {
          __probe: async (kind: string, args: Record<string, unknown>) => {
            const walks: { calls: number }[] = []
            const original = document.createTreeWalker.bind(document)
            // Counting through the real interface, rather than trusting the module's own numbers,
            // is what makes the budget assertions independent of the code under test.
            Object.assign(document, {
              createTreeWalker: (walkRoot: Node, whatToShow: number, filter: NodeFilter) => {
                const record = { calls: 0 }
                walks.push(record)
                return original(walkRoot, whatToShow, {
                  acceptNode: (node: Node) => {
                    record.calls += 1
                    return (filter as { acceptNode: (n: Node) => number }).acceptNode(node)
                  },
                })
              },
            })
            try {
              const result = await actions.runPageAction(kind, args, redact.redactionConfig())
              return { result, walkCalls: walks.map((walk) => walk.calls), bytes: JSON.stringify(result).length }
            } finally {
              Object.assign(document, { createTreeWalker: original })
            }
          },
        })
      })

      return {
        page,
        run: async (kind: string, args: Record<string, unknown> = {}): Promise<ProbeResult> => (
          await page.evaluate(
            ([actionKind, actionArgs]) => (globalThis as unknown as {
              __probe: (kind: string, args: Record<string, unknown>) => Promise<ProbeResult>
            }).__probe(actionKind as string, actionArgs as Record<string, unknown>),
            [kind, args] as const,
          )
        ),
      }
    },
    close: async (): Promise<void> => {
      await browser.close()
      await new Promise<void>((resolve) => { files.close(() => { resolve() }) })
    },
  }
}
