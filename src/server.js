/// FanBank HTTP server.
///
/// Thin REST surface over the wallet + fan-economy modules. The web
/// dashboard is served from /public and calls into these endpoints
/// through fetch. Every state-changing endpoint routes through the WDK
/// wallet loaded from WDK_SEED at boot; the private key never touches
/// the wire.
///
/// Because the operator runs one wallet for the demo, ALL bets, pool
/// contributions, and tips currently flow to that same address (the
/// wallet is both the fan and the escrow). This is a scoping compromise
/// for Round of 16; the Quarter-Final scope introduces per-fan seeds
/// so each visitor has their own custody separate from the operator.

import 'dotenv/config'
import express from 'express'
import rateLimit from 'express-rate-limit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ethers } from 'ethers'

import { createFanWallet } from './wdk/wallet.js'
import { TEAMS, getTeam } from './fan/teams.js'
import { assertSchedule, listMatches, settleMatch, getMatch } from './fan/matches.js'
import { tipTeam, tipPlayer } from './fan/tipping.js'
import { createPool, contribute, payout, listPools, readPool } from './fan/pool.js'
import { placeBet, marketState, settleMarket, snapshotAllMarkets, claimPayout } from './fan/prediction.js'
import { list as journalList, stats as journalStats, reset as journalReset } from './fan/journal.js'
import { resetOverrides as resetMatchOverrides } from './fan/matches.js'
import { recordExternalTip, recordExternalContribution, recordExternalBet } from './fan/external.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// Behind Vercel's proxy every request carries an X-Forwarded-For header.
// express-rate-limit v8 refuses to run without an explicit trust-proxy
// setting and throws a fatal error, which surfaces on Vercel as a raw
// FUNCTION_INVOCATION_FAILED. One hop is enough on Vercel.
app.set('trust proxy', 1)

app.use(express.json({ limit: '64kb' }))
app.use('/public', express.static(path.resolve(__dirname, '..', 'public')))
app.use('/', express.static(path.resolve(__dirname, '..', 'public')))

// Rate limit anything that costs a tx. Fan-economy demo runs on testnet
// so we're not scared of casual traffic, but a script that hammers
// /tip/team a thousand times would drain the operator gas balance.
const txLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  // Vercel proxies do not always send the standard header; disable the
  // strict validation so the middleware never throws mid-request.
  validate: { xForwardedForHeader: false, trustProxy: false },
})

let wallet = null
let bootPromise = null

async function bootWallet () {
  assertSchedule()
  wallet = await createFanWallet()
  console.log(`[fanbank] wallet ready ${wallet.address}`)
}

/// Lazily boot the WDK wallet on the first request. Cheap once resolved
/// because the promise is cached. Called from local dev startup AND
/// from every request via a top-level middleware, so Vercel cold starts
/// do not leak a "wallet not initialized" 503 to the first visitor.
function ensureWalletReady () {
  if (!bootPromise) {
    bootPromise = bootWallet().catch(err => {
      console.error('[fanbank] wallet boot failed:', err.message)
    })
  }
  return bootPromise
}

// Only API routes need the wallet ready. Blocking every request (including
// static file serves) on WDK boot would exceed Vercel's 10s cold-start
// timeout on Hobby plan and surface as FUNCTION_INVOCATION_FAILED.
app.use('/api', async (_req, _res, next) => {
  await ensureWalletReady()
  next()
})

/// Every endpoint that needs the wallet checks it here so a boot failure
/// surfaces as a clean 503 instead of an unhandled TypeError.
function requireWallet (res) {
  if (!wallet) {
    res.status(503).json({ error: 'Wallet not initialized. Check WDK_SEED / RPC_URL.' })
    return false
  }
  return true
}

// ─── Public read-only ───

app.get('/api/health', (_req, res) => {
  res.json({
    status: wallet ? 'ok' : 'booting',
    walletAddress: wallet?.address ?? null,
    chainRpc: wallet?.rpcUrl ?? null,
    usdt: wallet?.usdtAddress ?? null,
  })
})

/// Public network + contract config so the browser can sign transactions
/// itself via an injected wallet (MetaMask, Rabby, etc). USDt address,
/// chain id, and the operator's tip / escrow addresses are all public
/// data, safe to serve.
app.get('/api/config', (_req, res) => {
  const chainId = Number(process.env.CHAIN_ID || 84532)
  // Derive display name + block explorer from the chain id so a single
  // env-var flip switches every downstream link. Fall back to Base
  // Sepolia which is the default the app now ships against.
  const CHAIN_NAMES = { 1: 'Ethereum', 11155111: 'Sepolia', 8453: 'Base', 84532: 'Base Sepolia' }
  const EXPLORERS = {
    1: 'https://etherscan.io',
    11155111: 'https://sepolia.etherscan.io',
    8453: 'https://basescan.org',
    84532: 'https://sepolia.basescan.org',
  }
  res.json({
    chainId,
    chainName: process.env.CHAIN_NAME || CHAIN_NAMES[chainId] || 'Unknown',
    rpcHttp: wallet?.rpcUrl ?? process.env.RPC_URL ?? null,
    explorer: process.env.EXPLORER_URL || EXPLORERS[chainId] || 'https://sepolia.basescan.org',
    usdt: {
      address: wallet?.usdtAddress ?? null,
      decimals: wallet?.usdtDecimals ?? 6,
      symbol: 'USDT',
    },
    // The operator wallet acts as tip aggregator + pool escrow + prediction
    // market escrow in V1. Fans signing client-side send USDt here for
    // pool contributions and bets; direct tips go to the team address.
    escrow: wallet?.address ?? null,
  })
})

app.get('/api/teams', (_req, res) => res.json({ teams: TEAMS }))
app.get('/api/matches', (_req, res) => res.json({ matches: listMatches() }))
app.get('/api/match/:id', (req, res) => {
  const m = getMatch(req.params.id)
  if (!m) return res.status(404).json({ error: 'match not found' })
  res.json(m)
})
app.get('/api/markets', async (_req, res) => {
  try { res.json({ markets: await snapshotAllMarkets() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/market/:matchId', async (req, res) => {
  try { res.json(await marketState(req.params.matchId)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/pools', async (_req, res) => {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org')
    res.json({ pools: await listPools(provider) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/pool/:id/split', async (req, res) => {
  // v2 delegates split logic to the on-chain FanPoolManager. This
  // endpoint returns the pool's current state; the actual split is
  // computed by the contract at payout time.
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://sepolia.base.org')
    const pool = await readPool(Number(req.params.id), provider)
    res.json({ pool, note: 'Split is computed on-chain by FanPoolManager.payout{Equal,Proportional,WinnerTakes}. Call the payout endpoint to trigger it.' })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/journal', async (req, res) => {
  const filter = {}
  for (const k of ['type', 'matchId', 'poolId', 'teamId']) {
    if (req.query[k]) filter[k] = String(req.query[k])
  }
  try { res.json({ entries: await journalList(filter) }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/stats', async (_req, res) => {
  try { res.json(await journalStats()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/wallet', async (_req, res) => {
  if (!requireWallet(res)) return
  try {
    const [usdt, gas] = await Promise.all([wallet.getUsdtBalance(), wallet.getGasBalance()])
    res.json({
      address: wallet.address,
      chainRpc: wallet.rpcUrl,
      usdt,
      gas,
      info: wallet.getInfo(),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/// Smart Account (WDK ERC-4337) surface. Boots lazily on first request
/// so the server does not require a bundler URL to start. Returns the
/// smart account address, its USDt balance, and the underlying EOA
/// address so the UI can render both paths side by side.
let smartAccount = null
let smartAccountError = null
async function ensureSmartAccount () {
  if (smartAccount || smartAccountError) return
  try {
    const mod = await import('./wdk/smart-account.js')
    smartAccount = await mod.createFanBankSmartAccount()
    console.log(`[fanbank] smart account ready ${smartAccount.address}`)
  } catch (e) {
    smartAccountError = e
    console.warn('[fanbank] smart account not available:', e.message)
  }
}
app.get('/api/smart-account', async (_req, res) => {
  await ensureSmartAccount()
  if (smartAccountError) {
    return res.status(503).json({
      available: false,
      error: smartAccountError.message,
      hint: 'Set ERC4337_BUNDLER_URL in .env to enable the smart account path.',
    })
  }
  try {
    const [usdt] = await Promise.all([smartAccount.getUsdtBalance()])
    res.json({ available: true, usdt, ...smartAccount.getInfo() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/smart-account/tip-team', txLimit, async (req, res) => {
  await ensureSmartAccount()
  if (smartAccountError) return res.status(503).json({ error: 'smart account unavailable' })
  try {
    const { teamId, amount } = req.body ?? {}
    const team = (await import('./fan/teams.js')).getTeam(teamId)
    if (!team) throw new Error(`unknown team: ${teamId}`)
    if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) throw new Error('amount must be positive')
    const receipt = await smartAccount.transferUsdt(team.tipAddress, Number(amount))
    res.json({ ok: true, mode: 'erc4337', receipt })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ─── State-changing (require wallet) ───

app.post('/api/tip/team', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { teamId, amount } = req.body ?? {}
    const r = await tipTeam(wallet, teamId, Number(amount))
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/tip/player', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { teamId, playerName, amount } = req.body ?? {}
    const r = await tipPlayer(wallet, teamId, playerName, Number(amount))
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/create', async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { teamId, purpose, policy, payoutBefore } = req.body ?? {}
    const r = await createPool(wallet, { teamId, purpose, policy, payoutBefore })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/:id/contribute', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { amount } = req.body ?? {}
    const r = await contribute(wallet, {
      poolId: Number(req.params.id),
      amountUsdt: Number(amount),
    })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/:id/payout', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { recipients } = req.body ?? {}
    const r = await payout(wallet, Number(req.params.id), { recipients: recipients ?? [] })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/bet/:betId/claim', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const r = await claimPayout(wallet, Number(req.params.betId))
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/bet', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { matchId, outcome, amount } = req.body ?? {}
    const r = await placeBet(wallet, {
      matchId,
      outcome,
      amountUsdt: Number(amount),
    })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/// Demo-only: mark a match as settled with a given outcome. Real
/// production would replace this with a signed oracle push.
app.post('/api/match/:id/settle-demo', async (req, res) => {
  try {
    const { outcome, score } = req.body ?? {}
    res.json(settleMatch(req.params.id, { outcome, score }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/market/:matchId/settle', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try { res.json(await settleMarket(wallet, req.params.matchId)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

// ─── External wallet mode (client signed the tx already, just log it) ───

app.post('/api/tip/team/external', txLimit, async (req, res) => {
  try {
    const { teamId, amount, txHash, from, to } = req.body ?? {}
    res.json(await recordExternalTip({ target: 'team', teamId, amount, txHash, from, to }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/tip/player/external', txLimit, async (req, res) => {
  try {
    const { teamId, playerName, amount, txHash, from, to } = req.body ?? {}
    res.json(await recordExternalTip({ target: 'player', teamId, playerName, amount, txHash, from, to }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/:id/contribute/external', txLimit, async (req, res) => {
  try {
    const { amount, txHash, from, to } = req.body ?? {}
    res.json(await recordExternalContribution({ poolId: req.params.id, amount, txHash, from, to }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/bet/external', txLimit, async (req, res) => {
  try {
    const { matchId, outcome, amount, txHash, from, to } = req.body ?? {}
    res.json(await recordExternalBet({ matchId, outcome, amount, txHash, from, to }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/// Demo-only reset: wipe the off-chain journal and clear any settled
/// match overrides so the odds board goes back to its stock state. The
/// on-chain USDt transfers are untouched, they remain permanent tx that
/// judges can still verify on Etherscan. Kept unauthenticated because
/// the demo is public and there is nothing sensitive to protect.
app.post('/api/dev/reset', async (_req, res) => {
  try {
    await journalReset()
    resetMatchOverrides()
    res.json({ ok: true, cleared: ['journal', 'match-overrides'] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/// Demo-only faucet: mint MockUSDT from the operator wallet to the given
/// address. Used by the "Mint 10,000 test USDt" button when the fan is
/// in demo (server-signed) mode, since the mint() call in that case
/// cannot come from the browser signer.
app.post('/api/dev/mint', async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { to, amount } = req.body ?? {}
    const target = ethers.isAddress(to) ? to : wallet.address
    const amt = Number(amount) || 10000
    const MINT_ABI = ['function mint(address to, uint256 amount) external']
    if (!wallet.usdtAddress) throw new Error('USDT_ADDRESS not configured')
    const contract = new ethers.Contract(wallet.usdtAddress, MINT_ABI, wallet.signer)
    const raw = ethers.parseUnits(String(amt), wallet.usdtDecimals)
    const tx = await contract.mint(target, raw)
    const receipt = await tx.wait()
    if (receipt.status !== 1) throw new Error('Mint reverted on chain')
    res.json({ hash: tx.hash, to: target, amount: amt, blockNumber: receipt.blockNumber })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Local dev entry: node src/server.js. On Vercel we import { app } from
// api/index.js and wrap it into a serverless handler, so we skip listen().
if (process.env.VERCEL !== '1') {
  const port = Number(process.env.PORT || 3000)
  ensureWalletReady().finally(() => {
    app.listen(port, () => {
      console.log(`[fanbank] listening on http://localhost:${port}`)
    })
  })
}

export { app, ensureWalletReady }
