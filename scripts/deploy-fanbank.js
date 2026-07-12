/// Deploy the three FanBank contracts on Base Sepolia and seed the
/// team + player registry from src/fan/teams.js. Prints all addresses
/// + verify commands so the operator can paste them into .env and
/// verify on Basescan afterwards.

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ethers } from 'ethers'

const require = createRequire(import.meta.url)
const solc = require('solc')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONTRACT_DIR = path.resolve(__dirname, '..', 'contracts')

function compileAll () {
  const sources = {}
  for (const f of fs.readdirSync(CONTRACT_DIR)) {
    if (!f.endsWith('.sol')) continue
    sources[f] = { content: fs.readFileSync(path.join(CONTRACT_DIR, f), 'utf8') }
  }
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      evmVersion: 'paris',
    },
  })))
  if (out.errors) {
    const errs = out.errors.filter(e => e.severity === 'error')
    if (errs.length) { for (const e of errs) console.error(e.formattedMessage); throw new Error('compile failed') }
  }
  return {
    tipRouter: out.contracts['FanTipRouter.sol']['FanTipRouter'],
    poolManager: out.contracts['FanPoolManager.sol']['FanPoolManager'],
    market: out.contracts['ParimutuelMarket.sol']['ParimutuelMarket'],
  }
}

async function main () {
  const seed = process.env.WDK_SEED
  const rpc = process.env.RPC_URL || 'https://sepolia.base.org'
  const usdt = process.env.USDT_ADDRESS
  if (!seed) throw new Error('WDK_SEED missing in .env')
  if (!usdt) throw new Error('USDT_ADDRESS missing in .env, deploy MockUSDT first')

  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = ethers.Wallet.fromPhrase(seed).connect(provider)
  console.log(`[deploy] operator ${wallet.address}`)
  const bal = await provider.getBalance(wallet.address)
  console.log(`[deploy] gas balance ${ethers.formatEther(bal)} ETH`)
  if (bal < ethers.parseEther('0.01')) {
    console.warn('[deploy] LOW gas balance, top up before deploying')
  }
  console.log(`[deploy] USDT at ${usdt}`)

  console.log('[deploy] compiling...')
  const { tipRouter, poolManager, market } = compileAll()

  const tipFactory = new ethers.ContractFactory(tipRouter.abi, '0x' + tipRouter.evm.bytecode.object, wallet)
  const poolFactory = new ethers.ContractFactory(poolManager.abi, '0x' + poolManager.evm.bytecode.object, wallet)
  const marketFactory = new ethers.ContractFactory(market.abi, '0x' + market.evm.bytecode.object, wallet)

  console.log('[deploy] deploying FanTipRouter...')
  const tip = await tipFactory.deploy(usdt, wallet.address)
  await tip.waitForDeployment()
  const tipAddr = await tip.getAddress()
  console.log(`[deploy] FanTipRouter ${tipAddr}`)

  console.log('[deploy] deploying FanPoolManager...')
  const pool = await poolFactory.deploy(usdt)
  await pool.waitForDeployment()
  const poolAddr = await pool.getAddress()
  console.log(`[deploy] FanPoolManager ${poolAddr}`)

  console.log('[deploy] deploying ParimutuelMarket...')
  const mkt = await marketFactory.deploy(usdt, wallet.address, wallet.address)
  await mkt.waitForDeployment()
  const mktAddr = await mkt.getAddress()
  console.log(`[deploy] ParimutuelMarket ${mktAddr}`)

  // Seed the tip registry with all teams + top players so the demo
  // works out of the box. Team data comes from src/fan/teams.js.
  console.log('[deploy] seeding tip registry from src/fan/teams.js...')
  const teamsMod = await import('../src/fan/teams.js')
  const teams = teamsMod.TEAMS
  const tipRouterContract = new ethers.Contract(tipAddr, tipRouter.abi, wallet)
  for (const t of teams) {
    const tx = await tipRouterContract.registerTeam(t.id, t.tipAddress)
    await tx.wait()
    console.log(`[deploy]   team ${t.id} -> ${t.tipAddress}`)
    for (const p of t.players ?? []) {
      const tx2 = await tipRouterContract.registerPlayer(t.id, p.name, p.tipAddress)
      await tx2.wait()
      console.log(`[deploy]     player ${p.name} -> ${p.tipAddress}`)
    }
  }

  console.log('')
  console.log('=================================================================')
  console.log('  Fanbank v2 contracts deployed. Update .env:')
  console.log('')
  console.log(`  FANTIP_ROUTER_ADDRESS=${tipAddr}`)
  console.log(`  FANPOOL_MANAGER_ADDRESS=${poolAddr}`)
  console.log(`  PARIMUTUEL_MARKET_ADDRESS=${mktAddr}`)
  console.log('=================================================================')
  console.log('')
  console.log('Verify commands (Basescan):')
  console.log(`  forge verify-contract ${tipAddr} contracts/FanTipRouter.sol:FanTipRouter --chain base-sepolia --etherscan-api-key $BASESCAN_KEY --constructor-args $(cast abi-encode "constructor(address,address)" ${usdt} ${wallet.address})`)
  console.log(`  forge verify-contract ${poolAddr} contracts/FanPoolManager.sol:FanPoolManager --chain base-sepolia --etherscan-api-key $BASESCAN_KEY --constructor-args $(cast abi-encode "constructor(address)" ${usdt})`)
  console.log(`  forge verify-contract ${mktAddr} contracts/ParimutuelMarket.sol:ParimutuelMarket --chain base-sepolia --etherscan-api-key $BASESCAN_KEY --constructor-args $(cast abi-encode "constructor(address,address,address)" ${usdt} ${wallet.address} ${wallet.address})`)
}

main().catch(e => { console.error(e); process.exit(1) })
