/// Group fan pool module (on-chain).
///
/// Every pool is a struct in FanPoolManager. The creator opens a pool
/// with a purpose, a split policy (equal / proportional / winner takes
/// all), an optional team affiliation, and a payout time. Fans then
/// contribute USDt into the pool escrow until payout time, when the
/// creator triggers the payout call for their policy and the contract
/// distributes the pooled USDt.
///
/// Contrast with v1: v1 held the USDt in the operator's WDK wallet and
/// tracked splits off-chain. That worked as a demo but the funds sat in
/// a custodial wallet, the split was trust-me, and the operator could
/// have swept the pool. v2 sends USDt directly to FanPoolManager, and
/// the policy check is enforced by the vault on chain.

import { ethers } from 'ethers'
import { record } from './journal.js'
import { getTeam } from './teams.js'
import { bindOnChain, ensureAllowance, POLICY, POLICY_LABEL, DEFAULT_CONTRACTS } from './onchain.js'

const POOL_MANAGER_ADDR = () => process.env.FANPOOL_MANAGER_ADDRESS || DEFAULT_CONTRACTS.poolManager

function policyId (policyName) {
  const map = { equal: POLICY.Equal, proportional: POLICY.Proportional, 'winner-takes': POLICY.WinnerTakes }
  const id = map[policyName]
  if (id === undefined) throw new Error(`Unknown policy: ${policyName}`)
  return id
}

/// Create a pool. Returns { poolId, receipt, event }.
export async function createPool (fanWallet, { purpose, policy = 'equal', teamId = '', payoutBefore }) {
  if (!purpose || typeof purpose !== 'string' || purpose.trim().length === 0) {
    throw new Error('Pool purpose required')
  }
  const payoutTime = Math.floor(new Date(payoutBefore ?? Date.now() + 7 * 24 * 3600 * 1000).getTime() / 1000)
  if (payoutTime <= Math.floor(Date.now() / 1000)) throw new Error('payoutBefore must be in the future')

  const on = bindOnChain(fanWallet.signer)
  const tx = await on.poolManager.createPool(purpose, policyId(policy), teamId ?? '', payoutTime)
  const receipt = await tx.wait()

  // Extract poolId from event log.
  let poolId = null
  for (const log of receipt.logs) {
    try {
      const parsed = on.poolManager.interface.parseLog(log)
      if (parsed?.name === 'PoolCreated') { poolId = Number(parsed.args.poolId); break }
    } catch { /* not a poolManager log */ }
  }

  const team = teamId ? getTeam(teamId) : null
  const evt = await record({
    type: 'pool-created',
    poolId,
    operator: fanWallet.address,
    teamId: team?.id ?? null,
    teamName: team?.name ?? null,
    purpose,
    policy,
    payoutBefore: new Date(payoutTime * 1000).toISOString(),
    hash: tx.hash,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { poolId, receipt: { hash: tx.hash, blockNumber: receipt.blockNumber, status: 'success' }, event: evt }
}

/// A fan contributes USDt to a pool.
export async function contribute (fanWallet, { poolId, amountUsdt }) {
  if (poolId === undefined || poolId === null) throw new Error('poolId required')
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) throw new Error('Contribution must be a positive number of USDt')

  const decimals = fanWallet.usdtDecimals ?? 6
  const amountRaw = ethers.parseUnits(String(amountUsdt), decimals)
  const on = bindOnChain(fanWallet.signer)

  const approvalReceipt = await ensureAllowance({
    usdt: on.usdt,
    owner: fanWallet.address,
    spender: POOL_MANAGER_ADDR(),
    amountRaw,
  })

  const tx = await on.poolManager.contribute(poolId, amountRaw)
  const receipt = await tx.wait()
  const evt = await record({
    type: 'pool-contribution',
    poolId: Number(poolId),
    from: fanWallet.address,
    to: POOL_MANAGER_ADDR(),
    amount: amountUsdt,
    hash: tx.hash,
    approvalHash: approvalReceipt?.hash ?? null,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { receipt: { hash: tx.hash, status: 'success', blockNumber: receipt.blockNumber, from: fanWallet.address, amount: amountUsdt }, event: evt }
}

/// Read a pool's on-chain state.
export async function readPool (poolId, provider) {
  const on = bindOnChain(provider)
  const p = await on.poolManager.pools(poolId)
  return {
    poolId: Number(poolId),
    creator: p.creator,
    purpose: p.purpose,
    policy: POLICY_LABEL[Number(p.policy)],
    teamId: p.teamId,
    totalUsdt: Number(ethers.formatUnits(p.totalUsdt, 6)),
    payoutTime: Number(p.payoutTime),
    settled: p.settled,
  }
}

/// List every pool visible on chain. Scans nextPoolId, cheap since the
/// number is expected to stay under a few hundred for the demo.
export async function listPools (provider) {
  const on = bindOnChain(provider)
  const next = Number(await on.poolManager.nextPoolId())
  const pools = []
  for (let i = 0; i < next; i++) {
    const p = await on.poolManager.pools(i)
    pools.push({
      poolId: i,
      creator: p.creator,
      purpose: p.purpose,
      policy: POLICY_LABEL[Number(p.policy)],
      teamId: p.teamId,
      totalUsdt: Number(ethers.formatUnits(p.totalUsdt, 6)),
      payoutTime: Number(p.payoutTime),
      settled: p.settled,
    })
  }
  return pools
}

/// Trigger a payout for a pool. Wraps the three policy-specific calls
/// so callers just pass the recipients list.
export async function payout (fanWallet, poolId, { recipients }) {
  const on = bindOnChain(fanWallet.signer)
  const p = await on.poolManager.pools(poolId)
  if (!p || p.creator === ethers.ZeroAddress) throw new Error('Pool not found')

  const policyIdx = Number(p.policy)
  let tx
  if (policyIdx === POLICY.Equal) {
    tx = await on.poolManager.payoutEqual(poolId, recipients)
  } else if (policyIdx === POLICY.Proportional) {
    tx = await on.poolManager.payoutProportional(poolId, recipients)
  } else if (policyIdx === POLICY.WinnerTakes) {
    if (!recipients?.length) throw new Error('winner-takes payout needs one recipient')
    tx = await on.poolManager.payoutWinnerTakes(poolId, recipients[0])
  } else {
    throw new Error(`unknown policy ${policyIdx}`)
  }
  const receipt = await tx.wait()
  const evt = await record({
    type: 'pool-payout',
    poolId: Number(poolId),
    policy: POLICY_LABEL[policyIdx],
    recipients,
    hash: tx.hash,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'onchain',
  })
  return { receipt: { hash: tx.hash, status: 'success', blockNumber: receipt.blockNumber }, event: evt }
}
