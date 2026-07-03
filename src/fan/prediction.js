/// Prediction market on match outcomes.
///
/// Each match has a market with three outcomes (home / away / draw).
/// Fans place bets by sending USDt from their WDK wallet to the market
/// escrow address (in V1 = the operator's wallet, same custody trick as
/// the group pool). Once the match settles the market pays out to
/// winners pro-rata to their stake share of the winning side.
///
/// Odds are computed on the fly from the current stake distribution
/// (parimutuel style): if 60% of the total pool is on 'home' and home
/// wins, home backers receive their stake × (total / homeStake) = 1/0.6
/// ≈ 1.67× their stake. No fixed-odds book, no house edge, just a
/// pool split with a fixed 2% platform fee to keep the demo honest.
///
/// This is a conceptually simple pattern that Polymarket uses at
/// settle time. What FanBank adds is: the fan's stake is a real USDt
/// transfer from their WDK wallet, the payout is a real USDt transfer
/// back, and every step is journaled with tx hashes so the audit trail
/// is one grep away.

import { randomUUID } from 'node:crypto'
import { record, list } from './journal.js'
import { getMatch, listMatches } from './matches.js'

const PLATFORM_FEE_BPS = 200 // 2% fee kept by the operator

/// Place a bet on a match.
///   outcome: 'home' | 'away' | 'draw'
export async function placeBet (fanWallet, { matchId, outcome, amountUsdt, escrowAddress }) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  if (m.status !== 'scheduled') {
    throw new Error(`Match ${matchId} is ${m.status}, bets closed`)
  }
  if (!['home', 'away', 'draw'].includes(outcome)) {
    throw new Error(`Outcome must be home|away|draw, got ${outcome}`)
  }
  if (!escrowAddress) throw new Error('escrowAddress required (market operator address)')
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Stake must be a positive number of USDt')
  }
  const receipt = await fanWallet.sendUsdt(escrowAddress, amountUsdt)
  const evt = await record({
    type: 'bet-placed',
    betId: 'bet_' + randomUUID().slice(0, 8),
    matchId,
    matchStage: m.stage,
    matchLabel: `${m.home} vs ${m.away}`,
    outcome,
    amount: amountUsdt,
    from: receipt.from,
    to: escrowAddress,
    hash: receipt.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  })
  return { receipt, event: evt }
}

/// Compute market odds for a match. Returns per-outcome share and implied
/// odds, purely from the current stake distribution in the journal.
export async function marketState (matchId) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  const bets = (await list({ type: 'bet-placed', matchId }))
    .filter(b => b.status === 'success')
  let total = 0
  const byOutcome = { home: 0, away: 0, draw: 0 }
  for (const b of bets) {
    total += Number(b.amount)
    byOutcome[b.outcome] += Number(b.amount)
  }
  const odds = {}
  for (const k of ['home', 'away', 'draw']) {
    const stake = byOutcome[k]
    odds[k] = stake > 0 ? total / stake : null
  }
  return {
    matchId,
    matchLabel: `${m.home} vs ${m.away}`,
    status: m.status,
    resultOutcome: m.resultOutcome,
    resultScore: m.resultScore,
    totalStakeUsdt: total,
    betsCount: bets.length,
    stakeByOutcome: byOutcome,
    odds,
  }
}

/// Settle a market. Reads the match result, computes each winning
/// bettor's payout as (theirStake / totalWinningStake) * (netPool),
/// and sends USDt back from the operator wallet. Non-winners lose
/// their stake to the winning pool. Records one payout event per
/// winner + a summary event so the whole settlement is greppable.
export async function settleMarket (operatorWallet, matchId) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  if (m.status !== 'settled') {
    throw new Error(`Match ${matchId} is not settled yet`)
  }
  const winningOutcome = m.resultOutcome

  const bets = (await list({ type: 'bet-placed', matchId }))
    .filter(b => b.status === 'success')

  const totalStake = bets.reduce((s, b) => s + Number(b.amount), 0)
  const winningBets = bets.filter(b => b.outcome === winningOutcome)
  const winningStake = winningBets.reduce((s, b) => s + Number(b.amount), 0)

  const platformFee = (totalStake * PLATFORM_FEE_BPS) / 10000
  const netPool = totalStake - platformFee

  const transfers = []
  if (winningStake > 0) {
    // Group by winner address so we send one tx per winner even if a
    // single fan placed multiple bets on the same outcome.
    const perWinner = new Map()
    for (const b of winningBets) {
      const share = (Number(b.amount) / winningStake) * netPool
      perWinner.set(b.from, (perWinner.get(b.from) || 0) + share)
    }
    for (const [addr, amt] of perWinner) {
      if (amt <= 0) continue
      const receipt = await operatorWallet.sendUsdt(addr, amt)
      const evt = await record({
        type: 'bet-payout',
        matchId,
        winner: addr,
        amount: amt,
        hash: receipt.hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
      })
      transfers.push(evt)
    }
  }
  await record({
    type: 'market-settled',
    matchId,
    matchLabel: `${m.home} vs ${m.away}`,
    resultOutcome: winningOutcome,
    resultScore: m.resultScore,
    totalStakeUsdt: totalStake,
    winningStakeUsdt: winningStake,
    platformFeeUsdt: platformFee,
    payouts: transfers.length,
  })
  return {
    matchId,
    totalStakeUsdt: totalStake,
    winningStakeUsdt: winningStake,
    platformFeeUsdt: platformFee,
    netPoolUsdt: netPool,
    payouts: transfers.length,
  }
}

/// Convenience: snapshot of every market's current state, used by the
/// dashboard to render the odds board.
export async function snapshotAllMarkets () {
  const matches = listMatches()
  const rows = []
  for (const m of matches) {
    rows.push(await marketState(m.id))
  }
  return rows
}
