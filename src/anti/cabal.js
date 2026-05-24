import { db } from '../db/connection.js';
import { now } from '../utils.js';

export function addCabalCluster(label, walletAddresses, notes = '') {
  if (!label || !walletAddresses?.length) throw new Error('label and walletAddresses required');
  const clusterJson = JSON.stringify(walletAddresses);
  const existing = db.prepare('SELECT id FROM cabal_clusters WHERE label = ?').get(label);
  if (existing) {
    db.prepare('UPDATE cabal_clusters SET cluster_json = ?, notes = ?, updated_at_ms = ? WHERE id = ?')
      .run(clusterJson, notes, now(), existing.id);
    return { id: existing.id, updated: true };
  }
  const result = db.prepare(`
    INSERT INTO cabal_clusters (label, cluster_json, notes, first_detected_ms, last_active_ms, created_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(label, clusterJson, notes, now(), now(), now());
  return { id: result.lastInsertRowid, updated: false };
}

export function removeCabalCluster(labelOrId) {
  const num = Number(labelOrId);
  if (Number.isFinite(num)) {
    db.prepare('DELETE FROM cabal_clusters WHERE id = ?').run(num);
  } else {
    db.prepare('DELETE FROM cabal_clusters WHERE label = ?').run(labelOrId);
  }
}

export function cabalClustersList() {
  return db.prepare(`
    SELECT id, label, notes, total_tokens_tracked, last_active_ms,
      json_array_length(cluster_json) as wallet_count
    FROM cabal_clusters ORDER BY last_active_ms DESC
  `).all();
}
