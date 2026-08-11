/**
 * Folder lookup happens across the laptop connection, so replies can arrive out of order.
 * Only the reply for what is still in the field belongs on screen.
 */
export function isCurrentFolderReply(latestQuery: string, responseQuery: string): boolean {
  return latestQuery === responseQuery
}
