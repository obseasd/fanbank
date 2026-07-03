/// FanBank frontend runtime.
///
/// Vanilla JS, no framework. Sections:
///   1. Small helpers (API, formatting, DOM utilities)
///   2. Toast host (non-blocking notifications instead of alert())
///   3. Custom dropdown that renders team flags reliably (flagcdn.com)
///   4. Wallet pill + modal (server-side WDK wallet snapshot)
///   5. Tipping form, group pool form, prediction markets, journal
///   6. Boot: fetch state, wire event handlers, poll for live updates

const $ = sel => document.querySelector(sel)
const $$ = sel => [...document.querySelectorAll(sel)]

const EXPLORER = 'https://sepolia.etherscan.io'
const CHAIN_LABEL = 'Sepolia · chainId 11155111'
const FLAG_CDN = code => `https://flagcdn.com/w40/${code}.png`
const FLAG_CDN_LARGE = code => `https://flagcdn.com/w80/${code}.png`

const fmtUsdt = n => `${Number(n || 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDt`
const fmtGas = n => `${Number(n || 0).toFixed(4)} ETH`
const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'
const shortHash = h => h ? `${h.slice(0, 8)}…${h.slice(-6)}` : ''
const timeAgo = ts => {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

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

let TEAMS = []
let MATCHES = []
let WALLET = null

/* ─── Toasts ─── */
function toast ({ level = 'ok', title, desc, txHash, timeout = 5500 } = {}) {
  const host = $('#toasts')
  const el = document.createElement('div')
  el.className = `toast ${level}`
  const icon = level === 'ok' ? '✓' : '!'
  const link = txHash
    ? ` · <a href="${EXPLORER}/tx/${txHash}" target="_blank" rel="noopener">${shortHash(txHash)}</a>`
    : ''
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${desc || txHash ? `<div class="toast-desc">${desc || ''}${link}</div>` : ''}
    </div>
  `
  host.appendChild(el)
  setTimeout(() => {
    el.style.opacity = '0'
    el.style.transform = 'translateX(20px)'
    setTimeout(() => el.remove(), 260)
  }, timeout)
}

/* ─── Custom dropdown ─── */
function initDropdown (root, options, onChange, { placeholder, defaultValue } = {}) {
  const btn = root.querySelector('.dd-btn')
  const panel = root.querySelector('.dd-panel')
  const cur = root.querySelector('.dd-current')
  let current = null

  function render () {
    panel.innerHTML = options.map(o => `
      <div class="dd-item ${current === o.value ? 'active' : ''}" data-value="${o.value}">
        ${o.iso ? `<img src="${FLAG_CDN(o.iso)}" alt="${o.label} flag" loading="lazy" />` : ''}
        <div class="dd-item-body">
          <span class="dd-item-title">${o.label}</span>
          ${o.sub ? `<span class="dd-item-sub">${o.sub}</span>` : ''}
        </div>
      </div>
    `).join('')
    panel.querySelectorAll('.dd-item').forEach(item => {
      item.addEventListener('click', () => select(item.dataset.value))
    })
  }
  function select (value) {
    current = value
    const opt = options.find(o => o.value === value)
    if (opt) {
      cur.innerHTML = `
        ${opt.iso ? `<img src="${FLAG_CDN(opt.iso)}" alt="" />` : ''}
        <span>${opt.label}</span>
      `
    }
    root.classList.remove('open')
    render()
    onChange && onChange(value, opt)
  }

  cur.textContent = placeholder || 'Pick one'
  render()

  btn.addEventListener('click', e => {
    e.stopPropagation()
    // Close other dropdowns first
    $$('.dropdown.open').forEach(d => { if (d !== root) d.classList.remove('open') })
    root.classList.toggle('open')
  })
  document.addEventListener('click', e => {
    if (!root.contains(e.target)) root.classList.remove('open')
  })

  if (defaultValue) select(defaultValue)
  return { select, getValue: () => current }
}

let tipTeamDD, poolTeamDD, poolPolicyDD

/* ─── Wallet pill + modal ─── */
async function refreshWallet () {
  try {
    const w = await api('/api/wallet')
    WALLET = w
    updateWalletUI(w)
  } catch (e) {
    WALLET = null
    const pill = $('#wallet-pill')
    pill.classList.remove('ok')
    pill.classList.add('err')
    pill.querySelector('.label').textContent = 'wallet offline'
  }
}

function updateWalletUI (w) {
  const pill = $('#wallet-pill')
  pill.classList.remove('err')
  pill.classList.add('ok')
  pill.querySelector('.label').textContent = `${shortAddr(w.address)} · ${fmtUsdt(w.usdt)}`

  $('#mini-usdt').textContent = fmtUsdt(w.usdt)
  $('#mini-address').textContent = w.address
  $('#mini-explorer').href = `${EXPLORER}/address/${w.address}`

  $('#modal-address').textContent = w.address
  $('#modal-usdt').textContent = fmtUsdt(w.usdt)
  $('#modal-gas').textContent = fmtGas(w.gas)
  $('#modal-chain').textContent = CHAIN_LABEL
  $('#modal-explorer').href = `${EXPLORER}/address/${w.address}`
}

function openWalletModal () {
  if (!WALLET) return toast({ level: 'err', title: 'Wallet not ready', desc: 'The server has not initialized the WDK wallet yet. Check .env.' })
  $('#wallet-modal').hidden = false
}
function closeWalletModal () { $('#wallet-modal').hidden = true }

async function copyToClipboard (text, feedback) {
  try {
    await navigator.clipboard.writeText(text)
    toast({ level: 'ok', title: feedback || 'Copied', desc: text })
  } catch {
    toast({ level: 'err', title: 'Copy failed', desc: 'Clipboard permission was denied.' })
  }
}

/* ─── Stats strip ─── */
async function refreshStats () {
  try {
    const s = await api('/api/stats')
    $('#stat-tips').textContent = String(s.tipCount)
    $('#stat-tip-vol').textContent = fmtUsdt(s.tipVolumeUsdt)
    $('#stat-bets').textContent = String(s.betCount)
    $('#stat-bet-vol').textContent = fmtUsdt(s.betVolumeUsdt)
  } catch { /* keep previous */ }
}

/* ─── Tip form ─── */
async function submitTip () {
  const teamId = tipTeamDD.getValue()
  const amount = Number($('#tip-amount').value)
  const hint = $('#tip-hint')
  if (!teamId) { hint.className = 'hint err'; hint.textContent = 'Pick a team first.'; return }
  if (!amount || amount <= 0) { hint.className = 'hint err'; hint.textContent = 'Amount must be positive.'; return }
  const btn = $('#tip-btn')
  btn.disabled = true
  hint.className = 'hint'
  hint.textContent = 'Signing transfer via WDK…'
  try {
    const r = await api('/api/tip/team', { method: 'POST', body: { teamId, amount } })
    const team = TEAMS.find(t => t.id === teamId)
    hint.className = 'hint ok'
    hint.textContent = `Tipped ${fmtUsdt(amount)} to ${team?.name}. Tx ${shortHash(r.receipt.hash)}.`
    toast({ level: 'ok', title: `Tipped ${fmtUsdt(amount)} to ${team?.name}`, txHash: r.receipt.hash })
    $('#tip-amount').value = ''
    await Promise.all([refreshWallet(), refreshStats(), refreshJournal()])
  } catch (e) {
    hint.className = 'hint err'
    hint.textContent = e.message
    toast({ level: 'err', title: 'Tip failed', desc: e.message })
  } finally {
    btn.disabled = false
  }
}

/* ─── Pool form + list ─── */
async function submitPool () {
  const purpose = $('#pool-purpose').value.trim()
  const policy = poolPolicyDD.getValue() || 'equal'
  const teamId = poolTeamDD.getValue() || null
  if (!purpose) return toast({ level: 'err', title: 'Pool needs a purpose' })
  try {
    await api('/api/pool/create', { method: 'POST', body: { teamId, purpose, policy } })
    $('#pool-purpose').value = ''
    toast({ level: 'ok', title: 'Pool opened', desc: purpose })
    await Promise.all([refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Pool creation failed', desc: e.message })
  }
}

async function refreshPools () {
  try {
    const { pools } = await api('/api/pools')
    const root = $('#pools-list')
    if (!pools.length) { root.innerHTML = ''; return }
    root.innerHTML = pools.map(p => {
      const team = TEAMS.find(t => t.id === p.teamId)
      return `
        <div class="pool-row">
          <div>
            <div class="pool-title">${p.purpose || '(no purpose)'}</div>
            <div class="pool-meta">${team ? team.name + ' · ' : ''}${p.policy} · ${p.contributors} contributors</div>
          </div>
          <div class="pool-total">${fmtUsdt(p.totalUsdt)}</div>
          <button class="btn secondary sm" data-contribute="${p.poolId}">Contribute</button>
          ${p.settled
            ? '<span class="settled-badge">settled</span>'
            : `<button class="btn ghost sm" data-payout="${p.poolId}">Payout</button>`}
        </div>
      `
    }).join('')
    $$('button[data-contribute]').forEach(b => b.addEventListener('click', () => contributeToPool(b.dataset.contribute)))
    $$('button[data-payout]').forEach(b => b.addEventListener('click', () => payoutPool(b.dataset.payout)))
  } catch (e) {
    toast({ level: 'err', title: 'Pool list failed', desc: e.message })
  }
}

async function contributeToPool (poolId) {
  const amount = prompt('USDt amount to contribute?', '1')
  if (!amount) return
  try {
    const r = await api(`/api/pool/${poolId}/contribute`, { method: 'POST', body: { amount: Number(amount) } })
    toast({ level: 'ok', title: `Contributed ${fmtUsdt(amount)}`, txHash: r.receipt.hash })
    await Promise.all([refreshWallet(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Contribution failed', desc: e.message })
  }
}

async function payoutPool (poolId) {
  try {
    const { split, policy, totalUsdt } = await api(`/api/pool/${poolId}/split`)
    if (!split.length) return toast({ level: 'err', title: 'Nothing to split yet' })
    const preview = split.map(s => `  ${shortAddr(s.address)} ← ${fmtUsdt(s.amountUsdt)}`).join('\n')
    if (!confirm(`Payout ${fmtUsdt(totalUsdt)} with policy "${policy}"?\n\n${preview}`)) return
    await api(`/api/pool/${poolId}/payout`, { method: 'POST', body: {} })
    toast({ level: 'ok', title: 'Pool paid out', desc: `${fmtUsdt(totalUsdt)} across ${split.length} recipients` })
    await Promise.all([refreshWallet(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Payout failed', desc: e.message })
  }
}

/* ─── Markets ─── */
async function refreshMarkets () {
  try {
    const { markets } = await api('/api/markets')
    const root = $('#markets-list')
    if (!markets.length) { root.innerHTML = '<div class="hint">No markets yet.</div>'; return }
    root.innerHTML = markets.map(m => marketRow(m)).join('')
    $$('.odd:not(.disabled)').forEach(el => el.addEventListener('click', () => {
      placeBet(el.dataset.matchId, el.dataset.outcome)
    }))
    $$('button[data-settle]').forEach(el => el.addEventListener('click', () => settleDemoDialog(el.dataset.settle)))
  } catch (e) {
    $('#markets-list').innerHTML = `<div class="hint err">markets error: ${e.message}</div>`
  }
}

function marketRow (m) {
  const match = MATCHES.find(x => x.id === m.matchId) || {}
  const home = TEAMS.find(t => t.id === match.home)
  const away = TEAMS.find(t => t.id === match.away)
  const isSettled = m.status === 'settled'
  const isOpen = m.status === 'scheduled'
  const winnerLabel = m.resultOutcome === 'home' ? home?.name
    : m.resultOutcome === 'away' ? away?.name
    : m.resultOutcome === 'draw' ? 'Draw'
    : ''
  const winnerFlag = m.resultOutcome === 'home' ? home?.iso
    : m.resultOutcome === 'away' ? away?.iso : null

  return `
    <div class="market-row ${isSettled ? 'settled' : ''}">
      <div>
        <div class="market-teams">
          <span class="team">${home?.iso ? `<img src="${FLAG_CDN(home.iso)}" alt="" />` : ''}${home?.name ?? match.home}</span>
          <span class="vs">vs</span>
          <span class="team">${away?.iso ? `<img src="${FLAG_CDN(away.iso)}" alt="" />` : ''}${away?.name ?? match.away}</span>
        </div>
        <div class="market-meta">
          <span>${match.stage ?? ''}</span>
          <span class="dot">·</span>
          <span class="status status-${m.status}">${m.status}</span>
          ${m.resultScore ? `<span class="dot">·</span><span>${m.resultScore}</span>` : ''}
        </div>
      </div>
      ${oddCell(m, 'home', home, isOpen)}
      ${oddCell(m, 'draw', null, isOpen, 'Draw')}
      ${oddCell(m, 'away', away, isOpen)}
      ${isSettled
        ? `<span class="winner-badge">${winnerFlag ? `<img src="${FLAG_CDN(winnerFlag)}" alt="" />` : ''}Won: ${winnerLabel}</span>`
        : `<button class="btn ghost sm" data-settle="${m.matchId}">Settle demo…</button>`}
    </div>
  `
}

function oddCell (m, outcome, team, isOpen, labelOverride) {
  const odd = m.odds[outcome]
  const oddStr = odd ? `×${odd.toFixed(2)}` : '×—'
  const label = labelOverride || team?.name || outcome
  const flag = team?.iso ? `<img src="${FLAG_CDN(team.iso)}" alt="" />` : ''
  return `
    <div class="odd ${isOpen ? '' : 'disabled'}" data-match-id="${m.matchId}" data-outcome="${outcome}">
      <span class="odd-label">${flag}${label}</span>
      <span class="odd-value ${odd ? '' : 'na'}">${oddStr}</span>
    </div>
  `
}

async function placeBet (matchId, outcome) {
  const amount = prompt(`Stake in USDt on "${outcome}" ?`, '1')
  if (!amount) return
  try {
    const r = await api('/api/bet', { method: 'POST', body: { matchId, outcome, amount: Number(amount) } })
    toast({ level: 'ok', title: `Bet placed: ${fmtUsdt(amount)} on ${outcome}`, txHash: r.receipt.hash })
    await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Bet failed', desc: e.message })
  }
}

async function settleDemoDialog (matchId) {
  const outcome = prompt('Result (home / away / draw)?', 'home')
  if (!outcome) return
  const score = prompt('Final score (e.g. 2-1)?', '') || null
  try {
    await api(`/api/match/${matchId}/settle-demo`, { method: 'POST', body: { outcome, score } })
    const r = await api(`/api/market/${matchId}/settle`, { method: 'POST' })
    toast({ level: 'ok', title: 'Market settled', desc: `${r.payouts} payouts · ${fmtUsdt(r.netPoolUsdt)} distributed` })
    await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Settle failed', desc: e.message })
  }
}

/* ─── Journal ─── */
async function refreshJournal () {
  try {
    const { entries } = await api('/api/journal')
    const root = $('#journal')
    if (!entries.length) { root.innerHTML = ''; return }
    root.innerHTML = entries.slice(0, 60).map(e => `
      <div class="journal-row">
        <span class="journal-ts">${timeAgo(e.ts)}</span>
        <span class="journal-type">${e.type}</span>
        <span class="journal-desc">${describeEvent(e)}</span>
        ${e.hash
          ? `<a class="journal-hash" href="${EXPLORER}/tx/${e.hash}" target="_blank" rel="noopener">${shortHash(e.hash)} ↗</a>`
          : '<span class="journal-hash">off-chain</span>'}
      </div>
    `).join('')
  } catch (e) {
    $('#journal').innerHTML = `<div class="hint err">journal error: ${e.message}</div>`
  }
}

function describeEvent (e) {
  switch (e.type) {
    case 'tip':
      return e.target === 'team'
        ? `<span class="highlight">${fmtUsdt(e.amount)}</span> → ${e.teamName}`
        : `<span class="highlight">${fmtUsdt(e.amount)}</span> → ${e.playerName} (${e.teamName})`
    case 'pool-created':
      return `pool "${e.purpose ?? '?'}" ${e.teamName ? '· ' + e.teamName : ''} · policy ${e.policy}`
    case 'pool-contribution':
      return `<span class="highlight">${fmtUsdt(e.amount)}</span> → pool ${e.poolId}`
    case 'pool-payout':
      return `payout <span class="highlight">${fmtUsdt(e.amount)}</span> → ${shortAddr(e.to)}`
    case 'pool-settled':
      return `${e.policy} settle · ${fmtUsdt(e.totalUsdt)} across ${e.payouts} recipients`
    case 'bet-placed':
      return `bet <span class="highlight">${fmtUsdt(e.amount)}</span> on ${e.outcome} · ${e.matchLabel}`
    case 'bet-payout':
      return `payout <span class="highlight">${fmtUsdt(e.amount)}</span> → ${shortAddr(e.winner)}`
    case 'market-settled':
      return `${e.matchLabel} settled ${e.resultOutcome} ${e.resultScore ?? ''} · ${e.payouts} payouts`
    default:
      return JSON.stringify(e).slice(0, 100)
  }
}

/* ─── Bootstrapping ─── */
async function loadTeams () {
  const { teams } = await api('/api/teams')
  TEAMS = teams

  const options = teams.map(t => ({
    value: t.id,
    iso: t.iso,
    label: t.name,
    sub: t.nickname,
  }))
  tipTeamDD = initDropdown($('[data-dropdown="tip-team"]'), options, () => {}, {
    placeholder: 'Pick a team',
  })
  poolTeamDD = initDropdown($('[data-dropdown="pool-team"]'),
    [{ value: '', label: 'No team' }, ...options], () => {},
    { placeholder: 'No team', defaultValue: '' })

  poolPolicyDD = initDropdown($('[data-dropdown="pool-policy"]'), [
    { value: 'equal', label: 'Equal split', sub: 'Each contributor gets the same share' },
    { value: 'proportional', label: 'Proportional', sub: 'Share proportional to contribution' },
    { value: 'winner-takes', label: 'Winner takes all', sub: 'Single recipient' },
  ], () => {}, { placeholder: 'Equal split', defaultValue: 'equal' })
}

async function loadMatches () {
  const { matches } = await api('/api/matches')
  MATCHES = matches
}

// Wire buttons
$('#wallet-pill').addEventListener('click', openWalletModal)
$('#hero-cta-primary').addEventListener('click', openWalletModal)
$$('#wallet-modal [data-close]').forEach(el => el.addEventListener('click', closeWalletModal))
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeWalletModal() })

$('#tip-btn').addEventListener('click', submitTip)
$('#pool-create-btn').addEventListener('click', submitPool)

$('#mini-copy').addEventListener('click', () => WALLET && copyToClipboard(WALLET.address, 'Address copied'))
$('#modal-copy').addEventListener('click', () => WALLET && copyToClipboard(WALLET.address, 'Address copied'))

// Boot sequence
;(async () => {
  await loadTeams()
  await loadMatches()
  await Promise.all([refreshWallet(), refreshStats(), refreshMarkets(), refreshPools(), refreshJournal()])
  setInterval(refreshWallet, 30_000)
  setInterval(refreshMarkets, 20_000)
})()
