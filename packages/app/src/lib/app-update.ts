export interface PublishedBuild {
  build: string
}

/**
 * Ask the origin what it is actually serving. A laptop's bundled build is useful diagnostic
 * evidence, but it is not proof that a newer phone bundle exists: release and merge commits
 * legitimately have different hashes. Only the public manifest can make that claim.
 */
export async function publishedBuild(fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(`/build.json?check=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' },
    })
    if (!response.ok) return null
    const value = await response.json() as Partial<PublishedBuild>
    return typeof value.build === 'string' && value.build.trim() !== '' ? value.build : null
  } catch {
    return null
  }
}

/** Null means this phone already runs the public build, regardless of the daemon's commit. */
export function availableAppBuild(currentBuild: string, published: string | null): string | null {
  return published !== null && published !== currentBuild ? published : null
}
