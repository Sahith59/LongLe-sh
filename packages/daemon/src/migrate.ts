import type Database from 'better-sqlite3'

/**
 * Adds columns a newer release expects to a table an older release created.
 *
 * `CREATE TABLE IF NOT EXISTS` silently leaves an existing table alone, so a schema change
 * shipped in a later version reaches new installs and never reaches upgrades — the failure
 * only appears at runtime, as "no such column", long after the release looked fine.
 */
export function ensureColumns(
  db: Database.Database,
  table: string,
  columns: { name: string; definition: string }[],
): string[] {
  const existing = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
  )
  const added: string[] = []
  for (const column of columns) {
    if (existing.has(column.name)) continue
    // SQLite cannot add a NOT NULL column without a default; definitions here must allow it.
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`)
    added.push(column.name)
  }
  return added
}
