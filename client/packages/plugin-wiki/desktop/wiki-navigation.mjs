export function isWikiEntry(url, endpoint) {
  try {
    const target = new URL(url)
    return ['http:', 'https:'].includes(target.protocol)
      && target.origin === new URL(endpoint).origin
      && !target.username && !target.password
      && target.pathname === '/auth/wiki/open'
      && !target.search && !target.hash
  } catch { return false }
}

export function installWikiNavigation(contents, endpoint, onError) {
  contents.setWindowOpenHandler(({ url }) => {
    // Keep the Harness session in its existing partition; never export it to a browser.
    if (isWikiEntry(url, endpoint)) void contents.loadURL(url).catch(onError)
    return { action: 'deny' }
  })
}
