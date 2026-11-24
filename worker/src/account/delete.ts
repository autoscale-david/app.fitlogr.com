/**
 * Deletes every D1 row for one user and drops their sessions.
 * Google Photos is the user's own library: this function never calls the Photos API,
 * including album or media-item deletion.
 */
export async function deleteAccount(db: D1Database, userId: string, now: Date): Promise<void> {
  const revokedAt = now.toISOString();
  await db.batch([
    db.prepare("UPDATE photos SET duplicate_of_photo_id = NULL WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM meal_items WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM meals WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM photos WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM health_records WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM daily_summaries WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM sync_checkpoints WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM ai_requests WHERE user_id = ?").bind(userId),
    db.prepare("UPDATE user_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?").bind(revokedAt, userId),
    db.prepare("DELETE FROM user_sessions WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM oauth_states WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_oauth_tokens WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_google_photos WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_devices WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM user_settings WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}
