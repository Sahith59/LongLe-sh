import type { SessionListing } from './sessions.js'

export interface ManagedHandoffOwner {
  hasLiveSession(sessionId: string): boolean
  hasResumePoint(sessionId: string): boolean
  pauseSession(sessionId: string, actor: string, reason: string): Promise<boolean>
}

export interface ExternalHandoffOwner {
  hasLiveSession(sessionId: string): boolean
  stop(sessionId: string, actor: string): Promise<boolean>
}

export type PauseHandoffResult = { paused: boolean; message?: string }

/**
 * Pause whichever process owns the conversation now.
 *
 * `origin` is only provenance. A conversation born in VS Code can later be a managed SDK run,
 * so using origin to choose the stop channel addresses a process that no longer owns it.
 */
export async function pauseCurrentSessionOwner(
  managed: ManagedHandoffOwner,
  external: ExternalHandoffOwner,
  session: SessionListing,
  actor: string,
  reason: string,
): Promise<PauseHandoffResult> {
  if (managed.hasLiveSession(session.sessionId)) {
    if (!managed.hasResumePoint(session.sessionId)) {
      return {
        paused: false,
        message:
          'The source agent has not announced its native conversation ID yet, so LongLeash cannot guarantee a safe resume. No child was started. Wait for the first response to begin, then retry.',
      }
    }
    const paused = await managed.pauseSession(session.sessionId, actor, reason)
    return paused
      ? { paused: true }
      : {
          paused: false,
          message:
            'The source agent did not stop within the safety deadline and still owns this checkout. No child was started. Stop or finish that session, then retry.',
        }
  }
  if (external.hasLiveSession(session.sessionId)) {
    const paused = await external.stop(session.sessionId, actor)
    return paused
      ? { paused: true }
      : {
          paused: false,
          message:
            `The ${session.origin === 'vscode' ? 'VS Code' : 'Terminal'} agent process did not release the conversation, so LongLeash kept it in control and started no child. Close or stop it on the laptop, then retry.`,
        }
  }
  return managed.hasResumePoint(session.sessionId)
    ? { paused: true }
    : {
        paused: false,
        message:
          'LongLeash cannot find a live owner or a native conversation ID for this source. No child was started; the source was left unchanged.',
      }
}
