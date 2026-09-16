/**
 * Document-relative Host URL resolution: the one rule that keeps a served
 * shell working at the site root and behind a prefix-stripping path mount.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostBaseUrl, hostUrl } from '../src/client/host-base.ts'

function page(href: string): void {
  const url = new URL(href)
  vi.stubGlobal('location', { origin: url.origin, href: url.href })
  vi.stubGlobal('document', { baseURI: url.href })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('hostBaseUrl', () => {
  it('is the origin root for a page served at the site root', () => {
    page('http://127.0.0.1:3080/?token=abc#x')
    expect(hostBaseUrl()).toBe('http://127.0.0.1:3080/')
  })

  it('is the mount directory for a page served behind a path mount', () => {
    page('https://node.ts.net/dsh/?token=abc')
    expect(hostBaseUrl()).toBe('https://node.ts.net/dsh/')
  })

  it('treats the explicit index entry as its directory', () => {
    page('https://node.ts.net/dsh/index.html')
    expect(hostBaseUrl()).toBe('https://node.ts.net/dsh/')
  })

  it('falls back to the origin root when the document base is not this origin', () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/' })
    vi.stubGlobal('document', { baseURI: 'https://other.example/dir/' })
    expect(hostBaseUrl()).toBe('http://127.0.0.1:3080/')
    vi.stubGlobal('document', { baseURI: 'about:blank' })
    expect(hostBaseUrl()).toBe('http://127.0.0.1:3080/')
  })

  it('uses the origin root outside a document (a Worker) and an internal base without a location', () => {
    vi.stubGlobal('location', { origin: 'https://node.ts.net', href: 'https://node.ts.net/preview/bootstrap.js' })
    vi.stubGlobal('document', undefined)
    expect(hostBaseUrl()).toBe('https://node.ts.net/')
    vi.stubGlobal('location', undefined)
    expect(hostBaseUrl()).toBe('http://dsh.internal/')
    vi.stubGlobal('location', { origin: 'null', href: 'null' })
    expect(hostBaseUrl()).toBe('http://dsh.internal/')
  })
})

describe('hostUrl', () => {
  it('lands root-relative Host paths under the served base', () => {
    page('https://node.ts.net/dsh/')
    expect(hostUrl('/api/session.export').href).toBe('https://node.ts.net/dsh/api/session.export')
    expect(hostUrl('/api/remote.mux').href).toBe('https://node.ts.net/dsh/api/remote.mux')
    page('http://127.0.0.1:3080/')
    expect(hostUrl('/api/goals/create').href).toBe('http://127.0.0.1:3080/api/goals/create')
  })

  it('resolves document-relative paths against the base and passes absolute URLs through', () => {
    page('https://node.ts.net/dsh/')
    expect(hostUrl('plugins/events').href).toBe('https://node.ts.net/dsh/plugins/events')
    expect(hostUrl('https://cdn.example/x.js').href).toBe('https://cdn.example/x.js')
    expect(hostUrl('//cdn.example/x.js').href).toBe('https://cdn.example/x.js')
  })
})
