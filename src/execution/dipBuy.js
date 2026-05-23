import { db } from '../db/connection.js';
import { now } from '../utils.js';
import { fetchJupiterAsset } from '../enrichment/jupiter.js';
import { firstPositiveNumber } from '../utils.js';
import { activeStrategy } from '../db/settings.js';

export function getDipBuyState(mint) {
  return db.prepare('SELECT * FROM dip_buy_states WHERE mint = ?').get(mint) || null;
}

export function getAllDipBuyStatesByStep(step) {
  return db.prepare("SELECT * FROM dip_buy_states WHERE step = ? AND updated_at_ms > ?")
    .all(step, now() - 24 * 60 * 60 * 1000);
}

export function createDipBuyState(mint, strategyId, plannedSizeSol) {
  const existing = getDipBuyState(mint);
  if (existing) return existing;
  db.prepare(`
    INSERT INTO dip_buy_states (mint, strategy_id, step, planned_size_sol, executed_size_sol, created_at_ms, updated_at_ms)
    VALUES (?, ?, 'watching', ?, 0, ?, ?)
  `).run(mint, strategyId, plannedSizeSol, now(), now());
  return getDipBuyState(mint);
}

export function updateDipBuyStep(mint, step, updates = {}) {
  const sets = ['step = ?', 'updated_at_ms = ?'];
  const vals = [step, now()];
  for (const [key, value] of Object.entries(updates)) {
    if (['first_entry_price', 'first_entry_at_ms', 'lowest_price', 'bounce_price', 'executed_size_sol'].includes(key)) {
      sets.push(`${key} = ?`);
      vals.push(value);
    }
  }
  vals.push(mint);
  db.prepare(`UPDATE dip_buy_states SET ${sets.join(', ')} WHERE mint = ?`).run(...vals);
}

export function expireDipBuyState(mint) {
  db.prepare('DELETE FROM dip_buy_states WHERE mint = ?').run(mint);
}

export async function processDipBuyStates() {
  const states = getAllDipBuyStatesByStep('first_bounce');
  if (!states.length) return;

  for (const state of states) {
    try {
      const strat = activeStrategy();
      const asset = await fetchJupiterAsset(state.mint);
      const currentPrice = firstPositiveNumber(asset?.usdPrice);
      if (!currentPrice) continue;

      const bounceTriggerPct = strat.dip_bounce_trigger_pct ?? 5;
      const secondDipTolerancePct = strat.dip_second_dip_tolerance_pct ?? 10;
      const firstEntryPct = strat.dip_first_entry_pct ?? 10;

      // Check if price dropped back to second dip zone
      const firstEntryPrice = state.first_entry_price;
      const lowestPrice = state.lowest_price;
      if (!firstEntryPrice || !lowestPrice) continue;

      // Second dip: price drops back near first entry level
      const dropFromFirstEntry = (currentPrice - firstEntryPrice) / firstEntryPrice * 100;
      if (dropFromFirstEntry <= 0 && Math.abs(dropFromFirstEntry) <= secondDipTolerancePct) {
        // Execute remaining 90%
        const remainingSize = state.planned_size_sol - (state.executed_size_sol || 0);
        if (remainingSize > 0) {
          console.log(`[dipBuy] second dip confirmed for ${state.mint.slice(0, 8)}... executing ${remainingSize} SOL`);
          // The actual execution will happen via the normal pipeline
          // Mark as full_entry so the orchestrator knows
          updateDipBuyStep(state.mint, 'full_entry', {
            executed_size_sol: state.planned_size_sol,
          });
        }
      }

      // Check if price went too far up without second dip → expire
      const bounceFromLowest = lowestPrice > 0 ? (currentPrice - lowestPrice) / lowestPrice * 100 : 0;
      if (bounceFromLowest > 50) {
        console.log(`[dipBuy] ${state.mint.slice(0, 8)}... bounced >50% without second dip, expiring`);
        expireDipBuyState(state.mint);
      }
    } catch (err) {
      console.log(`[dipBuy] ${state.mint.slice(0, 8)}... error: ${err.message}`);
    }
  }
}
