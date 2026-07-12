/// Parimutuel prediction market module (on-chain).
///
/// Fans place bets on match outcomes by calling ParimutuelMarket
/// (which pulls USDt via transferFrom). Odds are the current stake
/// distribution, computed on-chain via odds(matchId). When the oracle
/// settles the match, winners claim their pro-rata share of the
/// remaining pool via claimPayout(betId).
///
/// v1 held bets in the operator wallet and split payouts off chain.
/// v2 uses the on-chain ParimutuelMarket contract so no custody, no
/// operator sweep path, and every bet + claim is a verifiable tx.

import { ethers } from 'ethers'
import { record, list as journalList } from './journal.js'
import { getMatch, listMatches } from './matches.js'
import { bindOnChain, ensureAllowance, OUTCOME, OUTCOME_LABEL } from './onchain.js'

const PLATFORM_FEE_BPS = 200

function outcomeToId (o) {
  if (typeof o === 'number') return o
  const map = { home: OUTCOME.Home, away: OUTCOME.Away, draw: OUTCOME.Draw }
  const id = map[String(o).toLowerCase()]
  if (id === undefined) throw new Error(`Unknown outcome: ${o}`)
  return id
}

/// Place a bet on a match. Returns { betId, receipt, event }.
///   outcome: 'home' | 'away' | 'draw' (or 0/1/2)
export async function placeBet (fanWallet, { matchId, outcome, amountUsdt }) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  if (m.status !== 'scheduled') throw new Error(`Match ${matchId} is ${m.status}, bets closed`)
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) throw new Error('Bet stake must be a positive number of USDt')

  const decimals = fanWallet.usdtDecimals ?? 6
  const amountRaw = ethers.parseUnits(String(amountUsdt), decimals)
  const on = bindOnChain(fanWallet.signer)

  const approvalReceipt = await ensureAllowance({
    usdt: on.usdt,
    owner: fanWallet.address,
    spender: process.env.PARIMUTUEL_MARKET_ADDRESS,
    amountRaw,
  })

  // Open the market lazily on the first bet, so the operator does not
  // need a pre-deploy hook. If it is already open, this reverts and
  // we catch below.
  try {
    const openTx = await on.market.openMarket(matchId)
    await openTx.wait()
  } catch (_) { /* already open, ignore */ }

  const tx = await on.market.placeBet(matchId, outcomeToId(outcome), amountRaw)
  const receipt = await tx.wait()

  let betId = null
  for (const log of receipt.logs) {
    try {
      const parsed = on.market.interface.parseLog(log)
      if (parsed?.name === 'BetPlaced') { betId = Number(parsed.args.betId); break }
    } catch { /* ignore */ }
  }

  const evt = await record({
    type: 'bet-placed',
    betId,
    matchId,
    matchStage: m.stage,
    matchLabel: `${m.home} vs ${m.away}`,
    outcome: String(outcome).toLowerCase(),
    amount: amountUsdt,
    from: fanWallet.address,
    to: process.env.PARIMUTUEL_MARKET_ADDRESS,
    hash: tx.hash,
    approvalHash: approvalReceipt?.hash ?? null,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { betId, receipt: { hash: tx.hash, status: 'success', blockNumber: receipt.blockNumber, from: fanWallet.address, amount: amountUsdt }, event: evt }
}

/// Snapshot the on-chain state for a single market.
export async function marketState (matchId) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org')
  const on = bindOnChain(provider)

  const raw = await on.market.markets(matchId)
  const isOpen = raw.matchId && raw.matchId.length > 0
  const total = Number(ethers.formatUnits(raw.totalStake, 6))
  const stakeByOutcome = {
    home: Number(ethers.formatUnits(raw.stakeHome, 6)),
    away: Number(ethers.formatUnits(raw.stakeAway, 6)),
    draw: Number(ethers.formatUnits(raw.stakeDraw, 6)),
  }
  const odds = { home: null, away: null, draw: null }
  for (const k of ['home', 'away', 'draw']) {
    if (stakeByOutcome[k] > 0 && total > 0) odds[k] = total / stakeByOutcome[k]
  }

  return {
    matchId,
    matchLabel: `${m.home} vs ${m.away}`,
    status: m.status,
    resultOutcome: raw.status === 1n ? OUTCOME_LABEL[Number(raw.winning)] : m.resultOutcome ?? null,
    resultScore: m.resultScore ?? null,
    totalStakeUsdt: total,
    betsCount: 0, // derived from event indexing in a follow-up; not on the contract state
    stakeByOutcome,
    odds,
    onChain: isOpen,
  }
}

export async function snapshotAllMarkets () {
  const rows = []
  for (const m of listMatches()) {
    rows.push(await marketState(m.id))
  }
  return rows
}

/// Oracle-only: settle a match on chain with the resulting outcome.
export async function settleMarket (operatorWallet, matchId) {
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  if (m.status !== 'settled') throw new Error(`Match ${matchId} not settled yet in the schedule`)

  const on = bindOnChain(operatorWallet.signer)
  const tx = await on.market.settleMarket(matchId, outcomeToId(m.resultOutcome))
  const receipt = await tx.wait()
  const evt = await record({
    type: 'market-settled',
    matchId,
    matchLabel: `${m.home} vs ${m.away}`,
    resultOutcome: m.resultOutcome,
    resultScore: m.resultScore,
    hash: tx.hash,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { receipt: { hash: tx.hash, status: 'success', blockNumber: receipt.blockNumber }, event: evt, matchId, resultOutcome: m.resultOutcome }
}

/// A bettor claims their payout after settlement.
export async function claimPayout (fanWallet, betId) {
  const on = bindOnChain(fanWallet.signer)
  const tx = await on.market.claimPayout(betId)
  const receipt = await tx.wait()
  const evt = await record({
    type: 'bet-payout',
    betId: Number(betId),
    hash: tx.hash,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { receipt: { hash: tx.hash, status: 'success', blockNumber: receipt.blockNumber }, event: evt }
}
