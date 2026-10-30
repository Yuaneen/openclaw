import { requiredString } from "./sqlite-store-records.js";
import type { WorkboardSqlConnection } from "./sqlite-store-schema.js";

// Conservative superset of needsWorkboardLifecycleReconciliation plus
// terminal worktree cleanup: settled history without active work is skipped.
export function readLifecycleCandidateIds(db: WorkboardSqlConnection): string[] {
  return db
    .prepare(
      `SELECT card.id FROM workboard_cards AS card
        WHERE card.archived_at IS NULL AND (
          card.status = 'running' OR card.execution_status = 'running'
          OR (card.status NOT IN ('review', 'blocked', 'done') AND (
            COALESCE(card.session_key, '') != '' OR COALESCE(card.run_id, '') != ''
            OR COALESCE(card.execution_id, '') != ''
          ))
          OR EXISTS (SELECT 1 FROM workboard_card_attempts AS attempt
            WHERE attempt.card_id = card.id AND attempt.status = 'running')
          OR COALESCE(card.automation_json, '') LIKE '%"phase":"prepared"%'
          OR card.claim_json IS NOT NULL
          OR card.stale_json IS NOT NULL
          OR COALESCE(card.automation_json, '') LIKE '%"kind":"worktree"%'
        )`,
    )
    .all()
    .map((row) => requiredString(row, "id"));
}

// Session lifecycle events also match a bare subagent key by suffix, a
// provisional workboard run id, and recorded attempt/event links.
export function readLifecycleEventCandidateIds(
  db: WorkboardSqlConnection,
  source: { sessionKey?: string; runId?: string },
): string[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (source.sessionKey) {
    clauses.push(
      "card.session_key = ?",
      "card.execution_session_key = ?",
      "(card.session_key LIKE 'subagent:workboard-%' AND ? LIKE '%:' || card.session_key)",
      "(COALESCE(card.session_key, '') = '' AND ? LIKE '%subagent:workboard-%' || card.id)",
      "EXISTS (SELECT 1 FROM workboard_card_attempts AS attempt WHERE attempt.card_id = card.id AND attempt.session_key = ?)",
      "EXISTS (SELECT 1 FROM workboard_card_events AS event WHERE event.card_id = card.id AND event.session_key = ?)",
    );
    params.push(
      source.sessionKey,
      source.sessionKey,
      source.sessionKey,
      source.sessionKey,
      source.sessionKey,
      source.sessionKey,
    );
  }
  if (source.runId) {
    clauses.push(
      "card.run_id = ?",
      "card.execution_run_id = ?",
      "card.run_id LIKE 'workboard:' || card.id || ':%'",
      "EXISTS (SELECT 1 FROM workboard_card_attempts AS attempt WHERE attempt.card_id = card.id AND attempt.run_id = ?)",
      "EXISTS (SELECT 1 FROM workboard_card_events AS event WHERE event.card_id = card.id AND event.run_id = ?)",
    );
    params.push(source.runId, source.runId, source.runId, source.runId);
  }
  if (clauses.length === 0) {
    return [];
  }
  return db
    .prepare(
      `SELECT card.id FROM workboard_cards AS card
        WHERE card.archived_at IS NULL AND (${clauses.join(" OR ")})`,
    )
    .all(...params)
    .map((row) => requiredString(row, "id"));
}
