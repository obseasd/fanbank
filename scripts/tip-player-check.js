/// Sanity check: sign one FanTipRouter.tipPlayer tx on live Base
/// Sepolia so we know the ERC20_ABI fix on the client is not the only
/// thing needed. Uses the operator wallet, not a browser one.

import 'dotenv/config'
import { ethers } from 'ethers'
import { bindOnChain, ensureAllowance } from '../src/fan/onchain.js'

const RPC = process.env.RPC_URL || 'https://sepolia.base.org'
const SEED = process.env.WDK_SEED
if (!SEED) throw new Error('need WDK_SEED in .env')

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = ethers.Wallet.fromPhrase(SEED).connect(provider)
console.log(`[tip-player] operator ${wallet.address}`)

const on = bindOnChain(wallet)

// 1. Verify Kylian Mbappé is registered on the router. The contract
// keys players by keccak256(teamId + "|" + playerName), not the naive
// packed pair. Match the contract's encoding exactly.
const nameHash = ethers.solidityPackedKeccak256(
  ['string', 'string', 'string'],
  ['france', '|', 'Kylian Mbappé']
)
const playerAddr = await on.tipRouter.playerAddress(nameHash)
console.log(`[tip-player] playerAddress[france|Kylian Mbappé] = ${playerAddr}`)
if (playerAddr === '0x0000000000000000000000000000000000000000') {
  console.log('[tip-player] player not registered on chain')
  console.log('[tip-player] this is likely why the browser tip failed')
  console.log('[tip-player] need to re-run scripts/deploy-fanbank.js seed step OR register manually')
  process.exit(1)
}

// 2. Ensure allowance for 100 USDT so the tx does not fail on approve.
const amount = ethers.parseUnits('1', 6)
const approvalReceipt = await ensureAllowance({
  usdt: on.usdt,
  owner: wallet.address,
  spender: process.env.FANTIP_ROUTER_ADDRESS || '0x55486bA74bcBF84B414802c8B6AB8f18BF3ABA6c',
  amountRaw: amount,
})
if (approvalReceipt) console.log(`[tip-player] approve tx ${approvalReceipt.hash}`)

// 3. Send the actual tipPlayer tx.
const tx = await on.tipRouter.tipPlayer('france', 'Kylian Mbappé', amount)
console.log(`[tip-player] tipPlayer tx ${tx.hash}`)
const rc = await tx.wait()
console.log(`[tip-player] confirmed in block ${rc.blockNumber}, status ${rc.status}`)
console.log(`[tip-player] https://sepolia.basescan.org/tx/${tx.hash}`)
