/// External-signature recorders.
///
/// When the fan connects their own wallet (MetaMask, Rabby, etc) the tx
/// is signed and broadcast client-side, and the server never sees a
/// seed. These helpers accept the resulting {txHash, from, amount} and
/// append the same journal entry the internal signer would have produced,
/// so the audit trail stays uniform across both modes.
///
/// For the MVP we trust the client's claim about which team / match /
/// outcome the tx was for. Production would verify the tx hash on chain
/// (receipt exists, USDt.Transfer log matches, recipient is the expected
/// team tip address, amount is >= expected), which is a straightforward
/// Q2 hardening.

import { record } from './journal.js'
import { getTeam, getPlayer } from './teams.js'
import { getMatch } from './matches.js'

function assertHash (txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    throw new Error('Invalid txHash')
  }
}

function assertAmount (n) {
  if (!Number.isFinite(n) || n <= 0) throw new Error('Amount must be a positive number')
}

export async function recordExternalTip ({ target, teamId, playerName, amount, txHash, from, to }) {
  assertHash(txHash)
  assertAmount(Number(amount))
  if (target === 'team') {
    const team = getTeam(teamId)
    if (!team) throw new Error(`Unknown team: ${teamId}`)
    return record({
      type: 'tip',
      target: 'team',
      teamId: team.id,
      teamName: team.name,
      to: to || team.tipAddress,
      amount: Number(amount),
      from,
      hash: txHash,
      status: 'success',
      source: 'external-wallet',
    })
  }
  if (target === 'player') {
    const player = getPlayer(teamId, playerName)
    if (!player) throw new Error(`Unknown player: ${playerName} on ${teamId}`)
    return record({
      type: 'tip',
      target: 'player',
      teamId: player.teamId,
      teamName: player.teamName,
      playerName: player.name,
      playerRole: player.role,
      to: to || player.tipAddress,
      amount: Number(amount),
      from,
      hash: txHash,
      status: 'success',
      source: 'external-wallet',
    })
  }
  throw new Error(`Unknown target: ${target}`)
}

export async function recordExternalContribution ({ poolId, amount, txHash, from, to }) {
  assertHash(txHash)
  assertAmount(Number(amount))
  if (!poolId) throw new Error('poolId required')
  return record({
    type: 'pool-contribution',
    poolId,
    from,
    to,
    amount: Number(amount),
    hash: txHash,
    status: 'success',
    source: 'external-wallet',
  })
}

export async function recordExternalBet ({ matchId, outcome, amount, txHash, from, to }) {
  assertHash(txHash)
  assertAmount(Number(amount))
  const m = getMatch(matchId)
  if (!m) throw new Error(`Unknown match: ${matchId}`)
  if (!['home', 'away', 'draw'].includes(outcome)) throw new Error(`outcome must be home|away|draw`)
  return record({
    type: 'bet-placed',
    betId: 'bet_' + txHash.slice(2, 10),
    matchId,
    matchStage: m.stage,
    matchLabel: `${m.home} vs ${m.away}`,
    outcome,
    amount: Number(amount),
    from,
    to,
    hash: txHash,
    status: 'success',
    source: 'external-wallet',
  })
}
