/// Deploy MockUSDT to the FanBank Sepolia wallet and mint 10 000 test
/// USDT to the deployer. Idempotent-ish: it always deploys a NEW contract
/// (no salt / CREATE2), so run it once and lock the printed address into
/// the .env USDT_ADDRESS field.

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ethers } from 'ethers'

const require = createRequire(import.meta.url)
const solc = require('solc')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOL_PATH = path.resolve(__dirname, '..', 'contracts', 'MockUSDT.sol')

function compile () {
  const source = fs.readFileSync(SOL_PATH, 'utf8')
  const input = {
    language: 'Solidity',
    sources: { 'MockUSDT.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input)))
  if (out.errors) {
    const errs = out.errors.filter(e => e.severity === 'error')
    if (errs.length) {
      for (const e of errs) console.error(e.formattedMessage)
      throw new Error('MockUSDT compilation failed')
    }
  }
  const artifact = out.contracts['MockUSDT.sol']['MockUSDT']
  return { abi: artifact.abi, bytecode: '0x' + artifact.evm.bytecode.object }
}

async function main () {
  const seed = process.env.WDK_SEED
  const rpc = process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'
  if (!seed) throw new Error('WDK_SEED missing. Populate .env before deploying.')

  const provider = new ethers.JsonRpcProvider(rpc)
  const wallet = ethers.Wallet.fromPhrase(seed).connect(provider)
  console.log(`[deploy] wallet ${wallet.address}`)
  const bal = await provider.getBalance(wallet.address)
  console.log(`[deploy] gas balance ${ethers.formatEther(bal)} ETH`)
  if (bal === 0n) {
    throw new Error(`Wallet has no ETH on ${rpc}. Fund it first.`)
  }

  console.log('[deploy] compiling MockUSDT...')
  const { abi, bytecode } = compile()

  console.log('[deploy] sending deploy tx...')
  const factory = new ethers.ContractFactory(abi, bytecode, wallet)
  const contract = await factory.deploy()
  console.log(`[deploy] tx ${contract.deploymentTransaction().hash}`)
  await contract.waitForDeployment()
  const addr = await contract.getAddress()
  console.log(`[deploy] MockUSDT deployed at ${addr}`)

  // Mint 10 000 USDT to ourselves so the demo has liquidity out of the box.
  const decimals = await contract.decimals()
  const amount = ethers.parseUnits('10000', decimals)
  console.log(`[deploy] minting 10000 USDT to ${wallet.address}...`)
  const mintTx = await contract.mint(wallet.address, amount)
  console.log(`[deploy] mint tx ${mintTx.hash}`)
  await mintTx.wait()
  const finalBal = await contract.balanceOf(wallet.address)
  console.log(`[deploy] final balance ${ethers.formatUnits(finalBal, decimals)} USDT`)

  console.log('')
  console.log('=================================================================')
  console.log('  Copy this into your .env:')
  console.log('')
  console.log(`  USDT_ADDRESS=${addr}`)
  console.log('  USDT_DECIMALS=6')
  console.log('=================================================================')
}

main().catch(e => { console.error(e.message); process.exit(1) })
