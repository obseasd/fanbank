/// Group tipping pool with smart split at payout.
///
/// A pool is opened by any fan for a specific purpose ("Team France
/// watch party fund", "Semi-final bus rental to Berlin"). Other fans
/// contribute USDt from their WDK wallets. At payout, the pool operator
/// splits according to the chosen policy:
///
///   equal         : split evenly across all contributors
///   proportional  : proportional to each fan's contribution
///   winner-takes  : one recipient chosen by the operator (or an oracle)
///   custom-splits : explicit percentages per address
///
/// Splits are computed off chain from the journal, then the payout is
/// executed as N on-chain transfers from the pool address to each
/// recipient. The pool address itself is a fresh WDK sub-account
/// derived from the operator's seed so custody stays with the operator
/// but the funds are visibly segregated from the operator's personal
/// wallet.
///
/// For the hackathon MVP the pool address = the operator's main wallet;
/// segregation via a sub-account or a smart-account escrow is a
/// Quarter-Finals upgrade.

import { randomUUID } from 'node:crypto'
import { record, list } from './journal.js'
import { getTeam } from './teams.js'

const VALID_POLICIES = new Set(['equal', 'proportional', 'winner-takes', 'custom-splits'])

/// Create a new pool. Only the metadata is stored; no on-chain action
/// yet. Fans join by contributing.
export async function createPool ({ operator, teamId, purpose, policy = 'equal', payoutBefore }) {
  if (!VALID_POLICIES.has(policy)) throw new Error(`Invalid split policy: ${policy}`)
  const team = teamId ? getTeam(teamId) : null
  if (teamId && !team) throw new Error(`Unknown team: ${teamId}`)
  const id = 'pool_' + randomUUID().slice(0, 8)
  const evt = await record({
    type: 'pool-created',
    poolId: id,
    operator,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    purpose,
    policy,
    payoutBefore: payoutBefore ?? null,
  })
  return { poolId: id, event: evt }
}

/// A fan contributes USDt to the pool. The transfer goes to the
/// operator's address (which serves as the pool custody address in V1).
export async function contribute (fanWallet, { poolId, operatorAddress, amountUsdt }) {
  if (!poolId) throw new Error('poolId required')
  if (!operatorAddress) throw new Error('operatorAddress required')
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Contribution amount must be a positive number of USDt')
  }
  const receipt = await fanWallet.sendUsdt(operatorAddress, amountUsdt)
  const evt = await record({
    type: 'pool-contribution',
    poolId,
    from: receipt.from,
    to: operatorAddress,
    amount: amountUsdt,
    hash: receipt.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  })
  return { receipt, event: evt }
}

/// Compute the split for the pool as of now based on the journal.
/// Returns the ordered list of (address, share) tuples plus the policy.
export async function computeSplit (poolId, { customSplits, winnerAddress } = {}) {
  const events = await list()
  const created = events.find(e => e.type === 'pool-created' && e.poolId === poolId)
  if (!created) throw new Error(`Pool not found: ${poolId}`)
  const contribs = events
    .filter(e => e.type === 'pool-contribution' && e.poolId === poolId && e.status === 'success')
    .reverse() // journal.list already reverses, undo for stable ordering

  const totalUsdt = contribs.reduce((s, c) => s + Number(c.amount), 0)
  const byFrom = new Map()
  for (const c of contribs) {
    byFrom.set(c.from, (byFrom.get(c.from) || 0) + Number(c.amount))
  }

  let split
  switch (created.policy) {
    case 'equal': {
      const uniqueFans = [...byFrom.keys()]
      if (uniqueFans.length === 0) split = []
      else {
        const each = totalUsdt / uniqueFans.length
        split = uniqueFans.map(addr => ({ address: addr, amountUsdt: each }))
      }
      break
    }
    case 'proportional': {
      split = [...byFrom.entries()].map(([addr, contributed]) => ({
        address: addr,
        amountUsdt: contributed,
      }))
      break
    }
    case 'winner-takes': {
      if (!winnerAddress) throw new Error('winner-takes policy requires winnerAddress')
      split = [{ address: winnerAddress, amountUsdt: totalUsdt }]
      break
    }
    case 'custom-splits': {
      if (!customSplits || !Array.isArray(customSplits)) {
        throw new Error('custom-splits policy requires customSplits: [{address, bps}]')
      }
      const totalBps = customSplits.reduce((s, x) => s + Number(x.bps || 0), 0)
      if (totalBps !== 10000) {
        throw new Error(`custom-splits must sum to 10000 bps, got ${totalBps}`)
      }
      split = customSplits.map(x => ({
        address: x.address,
        amountUsdt: (totalUsdt * Number(x.bps)) / 10000,
      }))
      break
    }
    default:
      throw new Error(`Unknown policy: ${created.policy}`)
  }

  return { poolId, policy: created.policy, totalUsdt, contributors: byFrom.size, split }
}

/// Execute the split: N USDt transfers from the operator's wallet to
/// each recipient. Records one payout event per recipient plus a summary
/// event so the pool has a clean audit trail.
export async function payout (operatorWallet, poolId, opts = {}) {
  const { split, totalUsdt, policy, contributors } = await computeSplit(poolId, opts)
  const transfers = []
  for (const s of split) {
    if (s.amountUsdt <= 0) continue
    const receipt = await operatorWallet.sendUsdt(s.address, s.amountUsdt)
    const evt = await record({
      type: 'pool-payout',
      poolId,
      to: s.address,
      amount: s.amountUsdt,
      hash: receipt.hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
    })
    transfers.push(evt)
  }
  await record({
    type: 'pool-settled',
    poolId,
    policy,
    totalUsdt,
    contributors,
    payouts: transfers.length,
  })
  return { poolId, policy, totalUsdt, transfers }
}

/// List active pools with contribution totals so far.
export async function listPools () {
  const events = await list()
  const pools = new Map()
  for (const e of events) {
    if (e.type === 'pool-created') {
      pools.set(e.poolId, {
        poolId: e.poolId,
        operator: e.operator,
        teamId: e.teamId,
        teamName: e.teamName,
        purpose: e.purpose,
        policy: e.policy,
        totalUsdt: 0,
        contributors: new Set(),
        settled: false,
      })
    } else if (e.type === 'pool-contribution' && e.status === 'success') {
      const p = pools.get(e.poolId)
      if (p) {
        p.totalUsdt += Number(e.amount)
        p.contributors.add(e.from)
      }
    } else if (e.type === 'pool-settled') {
      const p = pools.get(e.poolId)
      if (p) p.settled = true
    }
  }
  return [...pools.values()].map(p => ({
    ...p,
    contributors: p.contributors.size,
  }))
}
