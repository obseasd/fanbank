/// Match schedule + result oracle for the demo.
///
/// The Tether Developers Cup runs like a knockout tournament, so the
/// FanBank demo ships with a knockout bracket: 8 teams, quarter-finals
/// through final. Each match has a status:
///
///   scheduled  : bets accepted, kickoff in the future
///   live       : bets closed, match in progress
///   settled    : final score known, prediction market can auto-payout
///
/// In production the result oracle would be Chainlink Sports, a signed
/// oracle from a data provider, or a multi-source confirmation contract.
/// For the hackathon MVP the operator posts the final result manually
/// through a REST call, which triggers auto-settlement of all bets on
/// that match. This is the same pattern real prediction markets on
/// Polymarket / Kalshi use during their beta.

import { allTeamIds } from './teams.js'

const NOW_MS = Date.now()
const HOUR = 60 * 60 * 1000

/// Demo bracket. Kickoff times are relative to server start so the demo
/// always has "upcoming" matches to bet on, and one "settled" match
/// with a known result so the payout flow is easy to walk through.
const SCHEDULE = [
  // A settled match, one week ago, so we have example payouts in the journal.
  {
    id: 'm_qf1',
    stage: 'quarter-final',
    home: 'france', away: 'england',
    kickoff: NOW_MS - 7 * 24 * HOUR,
    status: 'settled',
    resultOutcome: 'home',
    resultScore: '2-1',
  },
  // A live match right now, bets closed.
  {
    id: 'm_qf2',
    stage: 'quarter-final',
    home: 'brazil', away: 'germany',
    kickoff: NOW_MS - 45 * 60 * 1000, // 45 min ago
    status: 'live',
    resultOutcome: null,
    resultScore: null,
  },
  // Upcoming matches, bets open.
  {
    id: 'm_qf3',
    stage: 'quarter-final',
    home: 'argentina', away: 'spain',
    kickoff: NOW_MS + 6 * HOUR,
    status: 'scheduled',
    resultOutcome: null,
    resultScore: null,
  },
  {
    id: 'm_sf1',
    stage: 'semi-final',
    home: 'france', away: 'brazil',
    kickoff: NOW_MS + 3 * 24 * HOUR,
    status: 'scheduled',
    resultOutcome: null,
    resultScore: null,
  },
  {
    id: 'm_final',
    stage: 'final',
    home: 'france', away: 'argentina',
    kickoff: NOW_MS + 6 * 24 * HOUR,
    status: 'scheduled',
    resultOutcome: null,
    resultScore: null,
  },
]

// In-memory result overrides so the demo REST endpoint can settle a match
// without restarting the server.
const RESULT_OVERRIDES = new Map()

export function listMatches () {
  return SCHEDULE.map(m => {
    const override = RESULT_OVERRIDES.get(m.id)
    return { ...m, ...(override || {}) }
  })
}

export function getMatch (id) {
  return listMatches().find(m => m.id === id) || null
}

/// Set the final outcome + score for a match. Called by the demo settle
/// endpoint. `outcome` is one of 'home' | 'away' | 'draw'.
export function settleMatch (id, { outcome, score }) {
  const m = getMatch(id)
  if (!m) throw new Error(`Unknown match: ${id}`)
  if (!['home', 'away', 'draw'].includes(outcome)) {
    throw new Error(`outcome must be home|away|draw, got ${outcome}`)
  }
  RESULT_OVERRIDES.set(id, {
    status: 'settled',
    resultOutcome: outcome,
    resultScore: score || null,
  })
  return getMatch(id)
}

/// Sanity-check that the teams referenced in the schedule are all known.
/// Throws on startup if the demo data is inconsistent, so we catch typos
/// early instead of at the "place bet" call.
export function assertSchedule () {
  const known = new Set(allTeamIds())
  for (const m of SCHEDULE) {
    if (!known.has(m.home)) throw new Error(`Match ${m.id}: unknown home team ${m.home}`)
    if (!known.has(m.away)) throw new Error(`Match ${m.id}: unknown away team ${m.away}`)
  }
}
