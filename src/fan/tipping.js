/// Fan tipping module.
///
/// A tip is a single USDt.transfer from the fan's WDK wallet to a target
/// address (team treasury or a specific player's tip wallet). No approval
/// step, no intermediary contract, no custodian. The wallet signs, the tx
/// lands, the journal records what the fan intended so the receipt page
/// can render "You tipped 2 USDt to Kylian Mbappé".

import { getTeam, getPlayer } from './teams.js'
import { record } from './journal.js'

/// Tip a whole team's treasury.
///   fanWallet: FanWallet
///   teamId: 'france' | 'brazil' | ...
///   amountUsdt: number
export async function tipTeam (fanWallet, teamId, amountUsdt) {
  const team = getTeam(teamId)
  if (!team) throw new Error(`Unknown team: ${teamId}`)
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Tip amount must be a positive number of USDt')
  }
  const receipt = await fanWallet.sendUsdt(team.tipAddress, amountUsdt)
  const evt = await record({
    type: 'tip',
    target: 'team',
    teamId: team.id,
    teamName: team.name,
    to: team.tipAddress,
    amount: amountUsdt,
    from: receipt.from,
    hash: receipt.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  })
  return { receipt, event: evt }
}

/// Tip a specific player. Same shape as tipTeam but resolves the player's
/// tip address off the team roster.
export async function tipPlayer (fanWallet, teamId, playerName, amountUsdt) {
  const player = getPlayer(teamId, playerName)
  if (!player) throw new Error(`Unknown player: ${playerName} (team ${teamId})`)
  if (!Number.isFinite(amountUsdt) || amountUsdt <= 0) {
    throw new Error('Tip amount must be a positive number of USDt')
  }
  const receipt = await fanWallet.sendUsdt(player.tipAddress, amountUsdt)
  const evt = await record({
    type: 'tip',
    target: 'player',
    teamId: player.teamId,
    teamName: player.teamName,
    playerName: player.name,
    playerRole: player.role,
    to: player.tipAddress,
    amount: amountUsdt,
    from: receipt.from,
    hash: receipt.hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber,
  })
  return { receipt, event: evt }
}
