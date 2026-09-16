/**
 * Document-relative Host URL resolution — the single rule that lets one served
 * shell work both at a site root (`http://127.0.0.1:3080/`) and behind a
 * path-mounting reverse proxy that strips its mount prefix before forwarding
 * (`https://node.ts.net/dsh/` → Host sees `/`). The dist is built with a
 * relative Vite base, so its static assets already resolve against the
 * document; every URL the shell *computes* (`/api/...`, the Remote stream
 * socket, `/plugins/...`) must follow the same rule instead of anchoring at
 * the origin, which under a mount would escape the prefix and 404.
 */

const INTERNAL_BASE = 'http://dsh.internal'

interface LocationLike {
  readonly origin?: string
  readonly href?: string
}

/**
 * The directory URL the shell document was served from, with a trailing slash:
 * `https://h/dsh/` for a path-mounted page, `https://h/` at the root, and for
 * `https://h/index.html` also `https://h/`. Outside a document (a Worker,
 * whose `location` is its script URL) the origin root is used, and without any
 * location (Node tests) a fixed internal base, matching the previous
 * origin-anchored behaviour in both cases.
 * @returns absolute directory URL ending in `/`.
 */
export function hostBaseUrl(): string {
  const global = globalThis as { document?: { baseURI?: string }; location?: LocationLike }
  const location = global.location
  const origin = location?.origin
  const hasOrigin = origin !== undefined && origin !== '' && origin !== 'null'
  const documentUrl = global.document?.baseURI
  if (hasOrigin && typeof documentUrl === 'string' && documentUrl !== '') {
    try {
      const directory = new URL('.', documentUrl)
      // A document whose base is not its own origin (an `about:` page, a
      // foreign <base href>) still resolves its Host at the origin root.
      if (directory.origin === origin) return directory.href
    } catch {
      // Fall through to the origin root.
    }
  }
  return hasOrigin ? `${origin}/` : `${INTERNAL_BASE}/`
}

/**
 * Resolve one Host path under {@link hostBaseUrl}: a root-relative path such
 * as `/api/session.export` lands under the served base (`/dsh/api/...` when
 * mounted), a document-relative path resolves as the browser would, and an
 * absolute or protocol-relative URL passes through unchanged.
 * @param path - the Host path or URL to resolve.
 * @returns the resolved absolute URL.
 */
export function hostUrl(path: string): URL {
  const base = hostBaseUrl()
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('//')) return new URL(path, base)
  return new URL(path.startsWith('/') ? `.${path}` : path, base)
}
