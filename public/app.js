/// FanBank frontend logic.
///
/// Single-page vanilla JS, no framework. Reads state from /api/* on load
/// and after every mutation, so the audit journal + market odds always
/// reflect the last on-chain state. Renders are dumb re-flows of the
/// entire card body from the fetched data; this keeps the code small
/// enough to audit in a few minutes and avoids state-sync bugs.

const $ = sel => document.querySelector(sel)
const $$ = sel => Array.from(document.querySelectorAll(sel))
const fmtUsdt = n => `${Number(n || 0).toFixed(2)} USDt`
const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
const shortHash = h => h ? `${h.slice(0, 8)}…${h.slice(-6)}` : ''
const timeAgo = ts => {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

let TEAMS = []
let MATCHES = []
let WALLET = null

async function api (path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function refreshWallet () {
  try {
    const w = await api('/api/wallet')
    WALLET = w
    $('#wallet-box').className = 'wallet ok'
    $('#wallet-box').textContent = `${shortAddr(w.address)} · ${fmtUsdt(w.usdt)}`
  } catch (e) {
    $('#wallet-box').className = 'wallet err'
    $('#wallet-box').textContent = `wallet offline: ${e.message.slice(0, 40)}`
  }
}

async function refreshStats () {
  try {
    const s = await api('/api/stats')
    $('#stat-tips').textContent = String(s.tipCount)
    $('#stat-tip-vol').textContent = fmtUsdt(s.tipVolumeUsdt)
    $('#stat-bets').textContent = String(s.betCount)
    $('#stat-bet-vol').textContent = fmtUsdt(s.betVolumeUsdt)
  } catch { /* silently keep last values */ }
}

async function loadTeams () {
  const { teams } = await api('/api/teams')
  TEAMS = teams
  const tipSel = $('#tip-team')
  const poolSel = $('#pool-team')
  const opts = teams.map(t => `<option value="${t.id}">${t.flag} ${t.name}</option>`).join('')
  tipSel.innerHTML = opts
  poolSel.innerHTML = `<option value="">No team</option>` + opts
}

async function loadMatches () {
  const { matches } = await api('/api/matches')
  MATCHES = matches
}

async function refreshMarkets () {
  try {
    const { markets } = await api('/api/markets')
    const root = $('#markets')
    if (!markets.length) {
      root.innerHTML = '<div class="hint">No markets available.</div>'
      return
    }
    root.innerHTML = markets.map(m => {
      const match = MATCHES.find(x => x.id === m.matchId) || {}
      const home = TEAMS.find(t => t.id === match.home)
      const away = TEAMS.find(t => t.id === match.away)
      const isSettled = m.status === 'settled'
      const isOpen = m.status === 'scheduled'
      const winnerLabel = m.resultOutcome
        ? (m.resultOutcome === 'home' ? home?.name : m.resultOutcome === 'away' ? away?.name : 'Draw')
        : '—'
      return `
        <div class="market-row">
          <div>
            <div class="name">${home?.flag ?? ''} ${home?.name ?? match.home} vs ${away?.name ?? match.away} ${away?.flag ?? ''}</div>
            <span class="stage">${match.stage ?? ''} · ${m.status}</span>
          </div>
          ${oddCell(m, 'home', home?.name, isOpen)}
          ${oddCell(m, 'draw', 'Draw', isOpen)}
          ${oddCell(m, 'away', away?.name, isOpen)}
          ${isSettled
            ? `<span class="settled-badge">Won: ${winnerLabel}</span>`
            : `<button class="secondary" data-settle="${m.matchId}">Settle demo…</button>`}
        </div>
      `
    }).join('')

    // Bind bet buttons
    $$('.market-row .odd').forEach(el => {
      el.addEventListener('click', () => {
        if (el.classList.contains('disabled')) return
        const { matchId, outcome } = el.dataset
        placeBet(matchId, outcome)
      })
    })
    $$('.market-row button[data-settle]').forEach(el => {
      el.addEventListener('click', () => settleDemoDialog(el.dataset.settle))
    })
  } catch (e) {
    $('#markets').innerHTML = `<div class="hint err">markets error: ${e.message}</div>`
  }
}

function oddCell (m, outcome, label, isOpen) {
  const odd = m.odds[outcome]
  const oddStr = odd ? `×${odd.toFixed(2)}` : '×—'
  const disabled = isOpen ? '' : ' disabled'
  return `
    <div class="odd${disabled}" data-match-id="${m.matchId}" data-outcome="${outcome}" data-match="${m.matchId}">
      <span class="l">${label ?? outcome}</span>
      <span class="o">${oddStr}</span>
    </div>
  `
}

async function placeBet (matchId, outcome) {
  const amount = prompt(`Stake in USDt on ${outcome}?`, '1')
  if (!amount) return
  try {
    await api('/api/bet', { method: 'POST', body: { matchId, outcome, amount: Number(amount) } })
    await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshJournal()])
  } catch (e) {
    alert(`Bet failed: ${e.message}`)
  }
}

async function settleDemoDialog (matchId) {
  const outcome = prompt('Result (home / away / draw)?', 'home')
  if (!outcome) return
  const score = prompt('Final score (e.g. 2-1)?', '') || null
  try {
    await api(`/api/match/${matchId}/settle-demo`, { method: 'POST', body: { outcome, score } })
    await api(`/api/market/${matchId}/settle`, { method: 'POST' })
    await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshJournal()])
    alert(`Market settled and paid out. Grep /api/journal to audit.`)
  } catch (e) {
    alert(`Settle failed: ${e.message}`)
  }
}

async function refreshPools () {
  try {
    const { pools } = await api('/api/pools')
    const root = $('#pools-list')
    if (!pools.length) {
      root.innerHTML = '<div class="hint">No pools open. Create one above.</div>'
      return
    }
    root.innerHTML = pools.map(p => `
      <div class="pool-row">
        <div>
          <div>${p.purpose || '(no purpose)'} <span class="label">${p.teamName ?? 'no team'}</span></div>
          <span class="label">policy · ${p.policy} · ${p.contributors} contributors</span>
        </div>
        <div class="val">${fmtUsdt(p.totalUsdt)}</div>
        <button class="secondary" data-contribute="${p.poolId}">Contribute</button>
        ${p.settled
          ? '<span class="settled-badge">settled</span>'
          : `<button class="secondary" data-payout="${p.poolId}">Payout</button>`}
      </div>
    `).join('')
    $$('button[data-contribute]').forEach(b => {
      b.addEventListener('click', () => contributePool(b.dataset.contribute))
    })
    $$('button[data-payout]').forEach(b => {
      b.addEventListener('click', () => payoutPool(b.dataset.payout))
    })
  } catch (e) {
    $('#pools-list').innerHTML = `<div class="hint err">pools error: ${e.message}</div>`
  }
}

async function contributePool (poolId) {
  const amount = prompt('USDt amount to contribute?', '1')
  if (!amount) return
  try {
    await api(`/api/pool/${poolId}/contribute`, { method: 'POST', body: { amount: Number(amount) } })
    await Promise.all([refreshWallet(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    alert(`Contribution failed: ${e.message}`)
  }
}

async function payoutPool (poolId) {
  try {
    const { split, policy, totalUsdt } = await api(`/api/pool/${poolId}/split`)
    if (!split.length) return alert('Nothing to split yet.')
    const preview = split.map(s => `${shortAddr(s.address)} ← ${fmtUsdt(s.amountUsdt)}`).join('\n')
    if (!confirm(`Payout ${fmtUsdt(totalUsdt)} with policy "${policy}"?\n\n${preview}`)) return
    await api(`/api/pool/${poolId}/payout`, { method: 'POST', body: {} })
    await Promise.all([refreshWallet(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    alert(`Payout failed: ${e.message}`)
  }
}

async function refreshJournal () {
  try {
    const { entries } = await api('/api/journal')
    const root = $('#journal')
    if (!entries.length) {
      root.innerHTML = '<div class="hint">No events yet. Tip a team to start.</div>'
      return
    }
    root.innerHTML = entries.slice(0, 40).map(e => `
      <div class="journal-row">
        <span class="ts">${timeAgo(e.ts)} ago</span>
        <span class="type">${e.type}</span>
        <span class="desc">${describe(e)}</span>
        <span class="hash">${shortHash(e.hash)}</span>
      </div>
    `).join('')
  } catch (e) {
    $('#journal').innerHTML = `<div class="hint err">journal error: ${e.message}</div>`
  }
}

function describe (e) {
  switch (e.type) {
    case 'tip':
      return e.target === 'team'
        ? `${fmtUsdt(e.amount)} → ${e.teamName}`
        : `${fmtUsdt(e.amount)} → ${e.playerName} (${e.teamName})`
    case 'pool-created':
      return `pool "${e.purpose ?? '?'}" ${e.teamName ? '(' + e.teamName + ')' : ''} · ${e.policy}`
    case 'pool-contribution':
      return `${fmtUsdt(e.amount)} → pool ${e.poolId}`
    case 'pool-payout':
      return `payout ${fmtUsdt(e.amount)} → ${shortAddr(e.to)}`
    case 'pool-settled':
      return `pool ${e.poolId} settled (${e.policy}, ${fmtUsdt(e.totalUsdt)} across ${e.payouts})`
    case 'bet-placed':
      return `${fmtUsdt(e.amount)} on ${e.outcome} · ${e.matchLabel}`
    case 'bet-payout':
      return `payout ${fmtUsdt(e.amount)} → ${shortAddr(e.winner)}`
    case 'market-settled':
      return `${e.matchLabel} settled ${e.resultOutcome} ${e.resultScore ?? ''} · ${e.payouts} payouts`
    default:
      return JSON.stringify(e).slice(0, 80)
  }
}

// Bind actions ─────────────────────────────────────────────────────────
$('#tip-btn').addEventListener('click', async () => {
  const teamId = $('#tip-team').value
  const amount = Number($('#tip-amount').value)
  const hint = $('#tip-hint')
  hint.className = 'hint'
  hint.textContent = 'sending…'
  try {
    const r = await api('/api/tip/team', { method: 'POST', body: { teamId, amount } })
    hint.className = 'hint ok'
    hint.textContent = `sent ${fmtUsdt(amount)} to ${teamId} · tx ${shortHash(r.receipt.hash)}`
    $('#tip-amount').value = ''
    await Promise.all([refreshWallet(), refreshStats(), refreshJournal()])
  } catch (e) {
    hint.className = 'hint err'
    hint.textContent = e.message
  }
})

$('#pool-create-btn').addEventListener('click', async () => {
  const purpose = $('#pool-purpose').value.trim()
  const policy = $('#pool-policy').value
  const teamId = $('#pool-team').value || null
  if (!purpose) return alert('Pool needs a purpose')
  try {
    await api('/api/pool/create', { method: 'POST', body: { teamId, purpose, policy } })
    $('#pool-purpose').value = ''
    await Promise.all([refreshPools(), refreshJournal()])
  } catch (e) {
    alert(`Create failed: ${e.message}`)
  }
})

// Boot ─────────────────────────────────────────────────────────────────
;(async () => {
  await loadTeams()
  await loadMatches()
  await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshPools(), refreshJournal()])
  setInterval(refreshWallet, 30_000)
  setInterval(refreshMarkets, 20_000)
})()
