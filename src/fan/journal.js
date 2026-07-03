/// Persistent journal for tips + pool contributions + prediction bets.
///
/// A tiny append-only JSON store in data/journal.json. Every economic
/// event (tip sent, pool contribution, bet placed, bet settled, refund)
/// gets one row. The web dashboard reads it to render history, and the
/// agent-wallet policy uses it to decide how the pool is deployed.
///
/// Why not a real database: the hackathon MVP does not need one. Fans
/// hold their own keys, all money moves live on chain, this file is
/// purely an off-chain audit trail. Judges can grep it.

import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, '..', '..', 'data')
const JOURNAL_PATH = path.join(DATA_DIR, 'journal.json')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

let cache = null

async function load () {
  if (cache) return cache
  try {
    const raw = await fs.readFile(JOURNAL_PATH, 'utf8')
    cache = JSON.parse(raw)
    if (!Array.isArray(cache)) cache = []
  } catch {
    cache = []
  }
  return cache
}

async function save () {
  await fs.writeFile(JOURNAL_PATH, JSON.stringify(cache, null, 2))
}

/// Append an event and persist. Events are JSON objects with at minimum
/// `type` and `ts`; specific event shapes live in tipping.js, pool.js,
/// prediction.js and are documented next to their record() calls.
export async function record (event) {
  const entries = await load()
  const withMeta = { ts: Date.now(), ...event }
  entries.push(withMeta)
  await save()
  return withMeta
}

/// Filtered read. Passing no filter returns everything, newest first.
export async function list (filter = {}) {
  const entries = await load()
  const filtered = entries.filter(e => {
    for (const [k, v] of Object.entries(filter)) {
      if (e[k] !== v) return false
    }
    return true
  })
  return filtered.slice().reverse()
}

/// Aggregated stats used by the dashboard header. Keeps the journal
/// as the single source of truth for "how much has moved through the
/// app so far", separate from chain balances which fluctuate.
export async function stats () {
  const entries = await load()
  let tipCount = 0
  let tipVolumeUsdt = 0
  let poolContribCount = 0
  let poolVolumeUsdt = 0
  let betCount = 0
  let betVolumeUsdt = 0
  for (const e of entries) {
    if (e.type === 'tip') {
      tipCount++
      tipVolumeUsdt += Number(e.amount || 0)
    } else if (e.type === 'pool-contribution') {
      poolContribCount++
      poolVolumeUsdt += Number(e.amount || 0)
    } else if (e.type === 'bet-placed') {
      betCount++
      betVolumeUsdt += Number(e.amount || 0)
    }
  }
  return {
    events: entries.length,
    tipCount,
    tipVolumeUsdt,
    poolContribCount,
    poolVolumeUsdt,
    betCount,
    betVolumeUsdt,
  }
}
