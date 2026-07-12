/// Fan tipping module.
///
/// A tip is a USDt payment routed through FanTipRouter, the FanBank
/// primitive contract that holds the registry of team + player
/// recipient addresses. The fan calls tipTeam(teamId, amount) and the
/// router pulls USDt via transferFrom and forwards to the recipient.
///
/// The router itself never holds funds beyond a single tx frame. The
/// registry lives on chain, so a new team address (e.g. an official
/// club treasury going live) is one setter call away without any
/// server redeploy.
///
/// Two flows are supported:
///   - onchain (via router): the canonical path used in demo mode by
///     the server's WDK operator wallet, and by client-side external
///     wallets via public/app.js. Emits a TeamTipped or PlayerTipped
///     event picked up by the audit journal.
///   - legacy direct sendUsdt: kept for backwards compatibility with
///     the pre-v2 journal entries that were written before the tip
///     router was deployed. New tips always route.

import { ethers } from 'ethers'
import { getTeam, getPlayer } from './teams.js'
import { record } from './journal.js'
import { bindOnChain, ensureAllowance } from './onchain.js'

/// Tip a whole team's treasury via the FanTipRouter contract.
///
/// The fan wallet must have USDt to spend and enough gas to send one
/// tx (or two if the router is not yet approved for that fan).
///
///   fanWallet: FanWallet with an ethers signer + usdtDecimals
///   teamId: 'france' | 'brazil' | ...
///   amountUsdt: number
export async function tipTeam (fanWallet, teamId, amountUsdt) {
  const team = getTeam(teamId)
  if (!team) throw new Error(`Unknown team: ${teamId}`)
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Tip amount must be a positive number of USDt')
  }

  const decimals = fanWallet.usdtDecimals ?? 6
  const amountRaw = ethers.parseUnits(String(amountUsdt), decimals)

  const on = bindOnChain(fanWallet.signer)
  const approvalReceipt = await ensureAllowance({
    usdt: on.usdt,
    owner: fanWallet.address,
    spender: process.env.FANTIP_ROUTER_ADDRESS,
    amountRaw,
  })

  const tx = await on.tipRouter.tipTeam(teamId, amountRaw)
  const receipt = await tx.wait()
  const evt = await record({
    type: 'tip',
    target: 'team',
    teamId: team.id,
    teamName: team.name,
    to: team.tipAddress,
    amount: amountUsdt,
    from: fanWallet.address,
    hash: tx.hash,
    approvalHash: approvalReceipt?.hash ?? null,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'router-onchain',
  })
  return {
    receipt: { hash: tx.hash, status: receipt.status === 1 ? 'success' : 'reverted', blockNumber: receipt.blockNumber, from: fanWallet.address, to: team.tipAddress, amount: amountUsdt },
    event: evt,
    approvalHash: approvalReceipt?.hash ?? null,
  }
}

/// Tip a specific player via the FanTipRouter. Same registry-lookup
/// pattern as tipTeam, but the router hashes (teamId, playerName) to
/// look up the player's registered recipient address.
export async function tipPlayer (fanWallet, teamId, playerName, amountUsdt) {
  const player = getPlayer(teamId, playerName)
  if (!player) throw new Error(`Unknown player: ${playerName} (team ${teamId})`)
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Tip amount must be a positive number of USDt')
  }

  const decimals = fanWallet.usdtDecimals ?? 6
  const amountRaw = ethers.parseUnits(String(amountUsdt), decimals)

  const on = bindOnChain(fanWallet.signer)
  const approvalReceipt = await ensureAllowance({
    usdt: on.usdt,
    owner: fanWallet.address,
    spender: process.env.FANTIP_ROUTER_ADDRESS,
    amountRaw,
  })

  const tx = await on.tipRouter.tipPlayer(teamId, playerName, amountRaw)
  const receipt = await tx.wait()
  const evt = await record({
    type: 'tip',
    target: 'player',
    teamId: player.teamId,
    teamName: player.teamName,
    playerName: player.name,
    playerRole: player.role,
    to: player.tipAddress,
    amount: amountUsdt,
    from: fanWallet.address,
    hash: tx.hash,
    approvalHash: approvalReceipt?.hash ?? null,
    status: receipt.status === 1 ? 'success' : 'reverted',
    blockNumber: receipt.blockNumber,
    source: 'router-onchain',
  })
  return {
    receipt: { hash: tx.hash, status: receipt.status === 1 ? 'success' : 'reverted', blockNumber: receipt.blockNumber, from: fanWallet.address, to: player.tipAddress, amount: amountUsdt },
    event: evt,
    approvalHash: approvalReceipt?.hash ?? null,
  }
}
