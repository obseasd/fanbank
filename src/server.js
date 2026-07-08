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

import { createFanWallet } from './wdk/wallet.js'
import { TEAMS, getTeam } from './fan/teams.js'
import { assertSchedule, listMatches, settleMatch, getMatch } from './fan/matches.js'
import { tipTeam, tipPlayer } from './fan/tipping.js'
import { createPool, contribute, computeSplit, payout, listPools } from './fan/pool.js'
import { placeBet, marketState, settleMarket, snapshotAllMarkets } from './fan/prediction.js'
import { list as journalList, stats as journalStats } from './fan/journal.js'
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
  res.json({
    chainId: Number(process.env.CHAIN_ID || 11155111),
    chainName: 'Sepolia',
    rpcHttp: wallet?.rpcUrl ?? process.env.RPC_URL ?? null,
    explorer: 'https://sepolia.etherscan.io',
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
  try { res.json({ pools: await listPools() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
app.get('/api/pool/:id/split', async (req, res) => {
  try { res.json(await computeSplit(req.params.id)) }
  catch (e) { res.status(400).json({ error: e.message }) }
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
    const r = await createPool({
      operator: wallet.address,
      teamId,
      purpose,
      policy,
      payoutBefore,
    })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/:id/contribute', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { amount } = req.body ?? {}
    const r = await contribute(wallet, {
      poolId: req.params.id,
      operatorAddress: wallet.address,
      amountUsdt: Number(amount),
    })
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

app.post('/api/pool/:id/payout', txLimit, async (req, res) => {
  if (!requireWallet(res)) return
  try {
    const { customSplits, winnerAddress } = req.body ?? {}
    const r = await payout(wallet, req.params.id, { customSplits, winnerAddress })
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
      escrowAddress: wallet.address,
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
