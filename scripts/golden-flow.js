/// Golden-flow live test on Base Sepolia. Signs one tx for every
/// FanBank primitive so the README has real verifiable proofs the
/// judges can click through:
///   1. Mint MockUSDT to operator (bootstrap)
///   2. Approve router
///   3. tipTeam("france", 5)
///   4. createPool("Berlin watch party") + contribute(2)
///   5. openMarket + placeBet(matchId, home, 3)
///
/// Prints every tx hash + Basescan link. Copy the block into the
/// README under a "verifiable golden flow" section.

import 'dotenv/config'
import { ethers } from 'ethers'
import { bindOnChain, ensureAllowance, POLICY, OUTCOME } from '../src/fan/onchain.js'

const RPC = process.env.RPC_URL || 'https://sepolia.base.org'
const SEED = process.env.WDK_SEED
const USDT = process.env.USDT_ADDRESS
if (!SEED || !USDT) throw new Error('need WDK_SEED + USDT_ADDRESS in .env')

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = ethers.Wallet.fromPhrase(SEED).connect(provider)
console.log(`[flow] operator ${wallet.address}`)

const on = bindOnChain(wallet)
const proofs = []

function log (label, tx) {
  const hash = tx?.hash ?? tx
  console.log(`[flow] ${label} tx ${hash}`)
  console.log(`[flow]   https://sepolia.basescan.org/tx/${hash}`)
  proofs.push({ label, hash })
}

async function mainFlow () {
  // 1. Ensure operator has USDT to spend.
  const usdtMintable = new ethers.Contract(USDT, ['function mint(address,uint256) external', 'function balanceOf(address) view returns (uint256)'], wallet)
  const bal = await usdtMintable.balanceOf(wallet.address)
  if (bal < ethers.parseUnits('100', 6)) {
    const t = await usdtMintable.mint(wallet.address, ethers.parseUnits('1000', 6))
    await t.wait()
    log('mint 1000 USDT to operator', t)
  } else {
    console.log(`[flow] operator already has ${ethers.formatUnits(bal, 6)} USDT, skipping mint`)
  }

  // 2. Approve all three routers once for a large amount so the
  //    subsequent txs are one-signature each.
  for (const [spenderName, spender] of [
    ['FanTipRouter', process.env.FANTIP_ROUTER_ADDRESS],
    ['FanPoolManager', process.env.FANPOOL_MANAGER_ADDRESS],
    ['ParimutuelMarket', process.env.PARIMUTUEL_MARKET_ADDRESS],
  ]) {
    const receipt = await ensureAllowance({
      usdt: on.usdt, owner: wallet.address, spender, amountRaw: ethers.parseUnits('1000', 6),
    })
    if (receipt) log(`approve ${spenderName} for 1000 USDT`, receipt)
    else console.log(`[flow] ${spenderName} already approved`)
  }

  // 3. Tip France 5 USDT via FanTipRouter.
  const tipTx = await on.tipRouter.tipTeam('france', ethers.parseUnits('5', 6))
  await tipTx.wait()
  log('tipTeam france 5 USDT via FanTipRouter', tipTx)

  // 4. Create a pool + contribute 2 USDT.
  const payoutTime = Math.floor(Date.now() / 1000) + 24 * 3600
  const createTx = await on.poolManager.createPool('Berlin watch party fund', POLICY.Equal, 'france', payoutTime)
  const createRc = await createTx.wait()
  log('createPool "Berlin watch party" via FanPoolManager', createTx)
  // Read the current nextPoolId to know which id we just wrote. This is
  // more reliable than parsing the event args because the event's
  // indexed uint arg comes back as a topic hash and BigInt casting can
  // trip on some setups.
  const nextPoolIdAfter = Number(await on.poolManager.nextPoolId())
  const poolId = nextPoolIdAfter - 1
  console.log(`[flow]   created poolId ${poolId} (nextPoolId now ${nextPoolIdAfter})`)

  // Small delay so the RPC has propagated the storage write to whatever
  // node handles the next estimateGas call.
  await new Promise(r => setTimeout(r, 2000))
  const contribTx = await on.poolManager.contribute(poolId, ethers.parseUnits('2', 6))
  await contribTx.wait()
  log(`contribute 2 USDT to pool ${poolId}`, contribTx)

  // 5. Open market + place a bet.
  try {
    const openTx = await on.market.openMarket('m_qf3')
    await openTx.wait()
    log('openMarket m_qf3 (argentina vs spain)', openTx)
  } catch { console.log('[flow] market m_qf3 already open') }

  const betTx = await on.market.placeBet('m_qf3', OUTCOME.Home, ethers.parseUnits('3', 6))
  await betTx.wait()
  log('placeBet m_qf3 home 3 USDT via ParimutuelMarket', betTx)

  console.log('')
  console.log('=============== VERIFIABLE GOLDEN FLOW ================')
  for (const p of proofs) {
    console.log(`- **${p.label}** — https://sepolia.basescan.org/tx/${p.hash}`)
  }
  console.log('=========================================================')
}

mainFlow().catch(e => { console.error(e); process.exit(1) })
