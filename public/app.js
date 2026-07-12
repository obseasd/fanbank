/// FanBank frontend runtime.
///
/// Vanilla JS, no framework. Two wallet modes are supported:
///
///   1. External wallet (recommended). User connects MetaMask / Rabby /
///      Coinbase / any EIP-1193 provider. Every tx (USDt transfer for
///      tips, pool contributions, bets) is signed client-side via ethers
///      and the server only receives the tx hash to append to the audit
///      journal. FanBank never touches the user's seed.
///
///   2. Demo mode. The server signs with a shared WDK wallet. Handy for
///      judges without MetaMask; every tx is still on chain but the same
///      wallet is fan + escrow. Clearly labeled in the modal.

const $ = sel => document.querySelector(sel)
const $$ = sel => [...document.querySelectorAll(sel)]

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

// Lazily read window.ethers each access so a slow UMD load does not
// freeze us to a stale (undefined) reference captured at script eval.
// The Proxy forwards property reads and instantiations to whatever is
// on window.ethers right now, with a friendly error if it never loaded.
const ethers = new Proxy({}, {
  get (_t, prop) {
    if (!window.ethers) {
      throw new Error('ethers library did not load. Refresh the page or disable a script blocker.')
    }
    return window.ethers[prop]
  },
})
let CONFIG = null            // { chainId, usdt, escrow, explorer, ... }
let CONNECTED = null         // { mode: 'external'|'demo', address, provider, signer, usdt, gas }
let TEAMS = []
let MATCHES = []

const FLAG_CDN = code => `https://flagcdn.com/w40/${code}.png`

const fmtUsdt = n => `${Number(n || 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDt`
const fmtGas = n => `${Number(n || 0).toFixed(4)} ETH`
const shortAddr = a => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '·'
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

/* ─── Local optimistic journal ───
 *
 * Vercel serverless writes the audit journal to /tmp, which is per Lambda
 * instance and resets on cold start. Between /api/bet/external and the
 * next /api/markets read, requests can land on different instances and
 * the write is invisible to the read. To make the demo trustworthy, every
 * successful state change is mirrored into localStorage; refresh helpers
 * merge that local cache into the server response, deduping by tx hash so
 * a bet is never double-counted once the server picks it up.
 */
const CLIENT_JOURNAL_KEY = 'fanbank-client-journal-v1'
const HIDDEN_POOLS_KEY = 'fanbank-hidden-pools-v1'
const RESET_AT_KEY = 'fanbank-reset-at-v1'

/// Returns the timestamp of the most recent Reset odds board click. Any
/// event older than this is filtered out of the merged journal, so if a
/// stale Lambda instance answers /api/journal with pre-reset data we do
/// not repaint it back into the UI.
function loadResetAt () {
  const raw = localStorage.getItem(RESET_AT_KEY)
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function loadClientEvents () {
  try {
    const arr = JSON.parse(localStorage.getItem(CLIENT_JOURNAL_KEY) || '[]')
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function pushClientEvent (event) {
  if (!event?.hash) return  // only track events with a real tx hash
  const arr = loadClientEvents()
  arr.push({ ts: Date.now(), status: 'success', source: 'local-optimistic', ...event })
  try { localStorage.setItem(CLIENT_JOURNAL_KEY, JSON.stringify(arr)) } catch { /* quota full */ }
}

/// Client-side "delete" for pools. The server has no delete endpoint
/// (pool history is append-only for audit), so removal is soft: hide the
/// pool from the display via a local blocklist AND purge any locally
/// mirrored events for that pool from the journal cache. On chain
/// contributions still exist as USDt txs and are still verifiable on
/// Etherscan, they just stop showing up in this browser.
function loadHiddenPools () {
  try {
    const arr = JSON.parse(localStorage.getItem(HIDDEN_POOLS_KEY) || '[]')
    return new Set(Array.isArray(arr) ? arr : [])
  } catch { return new Set() }
}
/// Hide a pool from the local view. Pool IDs arrive from three sources
/// (server journal number, local optimistic string, dataset attribute
/// string) so we normalize to string on both write and read; otherwise
/// Set.has(1) !== Set.has("1") and the pool re-appears on refresh.
function hidePool (poolId) {
  const key = String(poolId)
  const blocked = loadHiddenPools()
  blocked.add(key)
  try { localStorage.setItem(HIDDEN_POOLS_KEY, JSON.stringify([...blocked])) } catch {}
  const kept = loadClientEvents().filter(e => String(e.poolId) !== key)
  try { localStorage.setItem(CLIENT_JOURNAL_KEY, JSON.stringify(kept)) } catch {}
}

async function pendingLocalEvents () {
  try {
    const { entries } = await api('/api/journal')
    const seen = new Set((entries || []).map(e => e.hash).filter(Boolean))
    return loadClientEvents().filter(e => e.hash && !seen.has(e.hash))
  } catch {
    return loadClientEvents()
  }
}

/* ─── Toasts ─── */
let _toastSeq = 0
const _toastRegistry = new Map()

function toast ({ level = 'ok', title, desc, txHash, timeout = 5500 } = {}) {
  const host = $('#toasts')
  const el = document.createElement('div')
  el.className = `toast ${level}`
  const icon = level === 'ok' ? '✓' : '!'
  const link = txHash
    ? ` · <a href="${CONFIG?.explorer || 'https://sepolia.basescan.org'}/tx/${txHash}" target="_blank" rel="noopener">${shortHash(txHash)}</a>`
    : ''
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${desc || txHash ? `<div class="toast-desc">${desc || ''}${link}</div>` : ''}
    </div>
  `
  host.appendChild(el)
  const id = ++_toastSeq
  const timer = setTimeout(() => dismissToast(id), timeout)
  _toastRegistry.set(id, { el, timer })
  return id
}

function dismissToast (id) {
  const entry = _toastRegistry.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  entry.el.style.opacity = '0'
  entry.el.style.transform = 'translateX(20px)'
  setTimeout(() => entry.el.remove(), 260)
  _toastRegistry.delete(id)
}

/* ─── Wallet: injected provider detection + name ─── */
function detectInjected () {
  const eth = window.ethereum
  if (!eth) return { available: false, name: 'No wallet detected', hint: 'Install MetaMask, Rabby, or Coinbase Wallet' }
  if (eth.isMetaMask) return { available: true, name: 'MetaMask', icon: '🦊' }
  if (eth.isRabby) return { available: true, name: 'Rabby', icon: '🐰' }
  if (eth.isCoinbaseWallet) return { available: true, name: 'Coinbase Wallet', icon: '🔵' }
  if (eth.isBraveWallet) return { available: true, name: 'Brave Wallet', icon: '🦁' }
  return { available: true, name: 'Injected wallet', icon: '👛' }
}

/* ─── Wallet: connect + disconnect ─── */
async function connectInjected () {
  const eth = window.ethereum
  if (!eth) throw new Error('No browser wallet detected. Install MetaMask, Rabby, or Coinbase Wallet.')

  const provider = new ethers.BrowserProvider(eth)
  const accounts = await provider.send('eth_requestAccounts', [])
  if (!accounts?.length) throw new Error('No accounts returned by the wallet')

  // Ensure we're on the right network
  const net = await provider.getNetwork()
  if (Number(net.chainId) !== CONFIG.chainId) {
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: '0x' + CONFIG.chainId.toString(16) }])
    } catch (e) {
      // If the chain has never been added on this wallet, add it. The
      // display metadata (name, native currency symbol) comes from the
      // server config so a single env-var flip on Vercel changes the
      // network everywhere at once, no client redeploy required.
      if (e.code === 4902 || String(e.message || '').match(/unrecognized chain/i)) {
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x' + CONFIG.chainId.toString(16),
          chainName: CONFIG.chainName || 'Sepolia',
          nativeCurrency: { name: (CONFIG.chainName || 'Sepolia') + ' ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [CONFIG.rpcHttp || 'https://sepolia.base.org'],
          blockExplorerUrls: [CONFIG.explorer],
        }])
      } else {
        throw e
      }
    }
  }

  const signer = await provider.getSigner()
  const address = await signer.getAddress()
  CONNECTED = { mode: 'external', address, provider, signer }
  await refreshConnectedBalances()

  // Update UI state
  eth.on?.('accountsChanged', handleAccountsChanged)
  // Soft chain-change handler: refresh balances + warn on wrong chain,
  // but do NOT reload the page. A full reload drops the session and
  // makes wallet switching feel broken (the user wanted to change
  // networks, not sign out). If they land on the wrong chain, the next
  // tx attempt will trip the chain guard and prompt a switch back.
  eth.on?.('chainChanged', async () => {
    if (!CONNECTED?.provider) return
    try {
      const net = await CONNECTED.provider.getNetwork()
      const onRightChain = Number(net.chainId) === CONFIG.chainId
      if (!onRightChain) {
        toast({ level: 'err', title: 'Wrong network', desc: `Switch to ${CONFIG.chainName || 'Base Sepolia'} for tx to work.`, timeout: 4000 })
      }
      await refreshConnectedBalances().catch(() => {})
    } catch { /* ignore */ }
  })
  // Remember that this browser has been connected before, so the next
  // page load can silently reconnect via eth_accounts without popping
  // MetaMask again.
  try { localStorage.setItem('fanbank-connected', '1') } catch {}
  updatePillAndModal()
  // The visual result of a successful connect is the compact chip in the
  // header. Keeping the modal open on top of it feels redundant, so we
  // dismiss the modal as soon as the wallet is ready.
  closeWalletModal()
}

/// Silent reconnect on page load: if MetaMask has already granted this
/// origin access to an account (eth_accounts returns non-empty without
/// prompting), rebuild the CONNECTED state so refresh does not force the
/// user through the wallet modal again.
async function tryAutoReconnect () {
  if (!window.ethereum || !CONFIG) return
  try {
    if (localStorage.getItem('fanbank-connected') !== '1') return
    const accounts = await window.ethereum.request({ method: 'eth_accounts' })
    if (!accounts?.length) return
    await connectInjected()
  } catch (e) {
    // Silent failure is fine; user can always click Connect wallet.
    console.debug('[fanbank] auto-reconnect skipped:', e?.message)
  }
}

function handleAccountsChanged (accounts) {
  if (!accounts?.length) {
    disconnect()
  } else if (accounts[0].toLowerCase() !== CONNECTED?.address?.toLowerCase()) {
    // Account switched. Reload the connection.
    connectInjected().catch(err => toast({ level: 'err', title: 'Reconnect failed', desc: err.message }))
  }
}

async function connectDemo () {
  // Demo mode: the server's WDK wallet is the fan.
  const w = await api('/api/wallet')
  CONNECTED = {
    mode: 'demo',
    address: w.address,
    usdt: w.usdt,
    gas: w.gas,
    signer: null,
    provider: null,
  }
  try { localStorage.setItem('fanbank-connected', '1') } catch {}
  updatePillAndModal()
  closeWalletModal()
}

async function refreshConnectedBalances () {
  if (!CONNECTED) return
  if (CONNECTED.mode === 'external') {
    const usdt = new ethers.Contract(CONFIG.usdt.address, ERC20_ABI, CONNECTED.provider)
    const [raw, gasWei] = await Promise.all([
      usdt.balanceOf(CONNECTED.address),
      CONNECTED.provider.getBalance(CONNECTED.address),
    ])
    CONNECTED.usdt = Number(ethers.formatUnits(raw, CONFIG.usdt.decimals))
    CONNECTED.gas = Number(ethers.formatEther(gasWei))
  } else {
    // Demo mode uses server as source of truth
    try {
      const w = await api('/api/wallet')
      CONNECTED.usdt = w.usdt
      CONNECTED.gas = w.gas
    } catch { /* keep last known */ }
  }
  updatePillAndModal()
}

function updatePillAndModal () {
  const pill = $('#wallet-pill')
  const chip = $('#wallet-chip')
  const heroConnect = $('#hero-connect')

  if (!CONNECTED) {
    // Disconnected: show the big "Connect wallet" pill AND the hero CTA,
    // hide the compact chip.
    pill.hidden = false
    if (chip) chip.hidden = true
    if (heroConnect) heroConnect.hidden = false
    pill.classList.remove('ok', 'err')
    pill.querySelector('.label').textContent = 'Connect wallet'
    return
  }

  // Connected: swap the header pill out for the compact chip, and hide
  // the big "Connect wallet" CTA in the hero since it becomes a dead
  // signal once the wallet is already set up.
  pill.hidden = true
  if (heroConnect) heroConnect.hidden = true
  if (chip) {
    chip.hidden = false
    chip.querySelector('.addr').textContent = shortAddr(CONNECTED.address)
    chip.querySelector('.bal').textContent = fmtUsdt(CONNECTED.usdt)
  }

  $('#modal-address').textContent = CONNECTED.address
  $('#modal-usdt').textContent = fmtUsdt(CONNECTED.usdt)
  $('#modal-gas').textContent = fmtGas(CONNECTED.gas)
  $('#modal-explorer').href = `${CONFIG.explorer}/address/${CONNECTED.address}`
  // Chain row reads the live server config so a chain flip on Vercel
  // immediately reflects in the modal instead of showing stale HTML.
  const chainEl = $('#modal-chain')
  if (chainEl) chainEl.textContent = `${CONFIG.chainName || 'Unknown'} · chainId ${CONFIG.chainId}`
  $('#connected-source').textContent = CONNECTED.mode === 'external'
    ? `Signed from your browser wallet. FanBank never sees your seed.`
    : `Using the shared demo wallet on the server. All tx sign from the same WDK seed.`
}

function showConnectedView () {
  $('[data-view="connect"]').hidden = true
  $('[data-view="connected"]').hidden = false
  updatePillAndModal()
}
function showConnectView () {
  $('[data-view="connect"]').hidden = false
  $('[data-view="connected"]').hidden = true
  const inj = detectInjected()
  $('#injected-icon').textContent = inj.icon || '👛'
  $('#injected-title').textContent = inj.name
  $('#injected-sub').textContent = inj.available ? 'Detected browser wallet' : inj.hint
  $('.wallet-option[data-connect="injected"]').disabled = !inj.available
  updatePillAndModal()
}
function disconnect () {
  if (CONNECTED?.provider && window.ethereum?.removeListener) {
    try { window.ethereum.removeListener('accountsChanged', handleAccountsChanged) } catch {}
  }
  CONNECTED = null
  try { localStorage.removeItem('fanbank-connected') } catch {}
  showConnectView()
  updatePillAndModal()
  toast({ level: 'ok', title: 'Wallet disconnected' })
}

function openWalletModal () {
  $('#wallet-modal').hidden = false
  if (CONNECTED) showConnectedView(); else showConnectView()
}
function closeWalletModal () { $('#wallet-modal').hidden = true }

async function copyToClipboard (text, feedback) {
  try {
    await navigator.clipboard.writeText(text)
    toast({ level: 'ok', title: feedback || 'Copied', desc: text })
  } catch {
    toast({ level: 'err', title: 'Copy failed', desc: 'Clipboard permission denied' })
  }
}

/* ─── Ensure connected before any tx ─── */
async function ensureConnected () {
  if (CONNECTED) return CONNECTED
  openWalletModal()
  throw new Error('Please connect a wallet first')
}

/// Verify the injected wallet is still on the FanBank chain, and prompt
/// to switch if not. Users often flip chains between sessions (or a wallet
/// resets after a browser restart). Without this guard, an approve() on
/// mainnet would silently drain gas for nothing.
async function ensureCorrectChain () {
  if (CONNECTED?.mode !== 'external') return
  const net = await CONNECTED.provider.getNetwork()
  if (Number(net.chainId) === CONFIG.chainId) return
  toast({ level: 'err', title: 'Wrong network', desc: `Switch your wallet to ${CONFIG.chainName || 'the configured chain'} and try again.` })
  try {
    await CONNECTED.provider.send('wallet_switchEthereumChain', [{ chainId: '0x' + CONFIG.chainId.toString(16) }])
  } catch (e) {
    throw new Error(`Please switch your wallet to ${CONFIG.chainName || 'chainId ' + CONFIG.chainId}.`)
  }
  await new Promise(r => setTimeout(r, 400))
  const after = await CONNECTED.provider.getNetwork()
  if (Number(after.chainId) !== CONFIG.chainId) throw new Error('Network switch not confirmed')
}

/// Preflight balance check before a tx that spends USDt. Returns a
/// short human string when the wallet lacks USDt or gas, so we can
/// surface a helpful toast BEFORE bothering the wallet with a signature
/// request that would just fail.
function preflightSpend (amount) {
  if (CONNECTED?.mode !== 'external') return null
  const usdt = Number(CONNECTED.usdt || 0)
  const gas = Number(CONNECTED.gas || 0)
  if (amount > usdt) return `You have ${fmtUsdt(usdt)}. Mint some test USDt from your wallet card.`
  if (gas <= 0) return `You have no ${CONFIG.chainName || 'network'} ETH for gas. Grab some from a Sepolia faucet.`
  return null
}

/// Convert an ethers or wallet error into a human sentence. Covers the
/// common cases (user rejection, insufficient funds, RPC rate limits,
/// contract reverts) without leaking stack traces into the toast body.
function friendlyError (e) {
  const raw = e?.shortMessage || e?.reason || e?.message || String(e || 'Unknown error')
  const code = e?.code || e?.info?.error?.code
  if (code === 'ACTION_REJECTED' || code === 4001 || /user (rejected|denied|cancel)/i.test(raw)) {
    return 'You cancelled the signature.'
  }
  if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(raw)) {
    return 'Not enough ETH for gas. Top up on a Sepolia faucet.'
  }
  if (/nonce too low|replacement transaction underpriced/i.test(raw)) {
    return 'A previous tx is still pending. Wait a few seconds and retry.'
  }
  if (/execution reverted:?\s*(.*)/i.test(raw)) {
    const m = raw.match(/execution reverted:?\s*(.*)/i)
    return `Contract reverted${m[1] ? ': ' + m[1].slice(0, 120) : ''}`
  }
  if (/network|fetch|rpc/i.test(raw)) return 'Network error. Check your connection and retry.'
  return String(raw).slice(0, 180)
}

/* ─── Generic modal ─────────────────────────────────────────────────
 *
 * Reusable dialog that replaces prompt() and confirm() everywhere.
 * One DOM container is lazily created on first call and reused for
 * every subsequent open. openModal({ title, description, fields, ... })
 * returns a Promise that resolves with { name: value, ... } on submit,
 * or null on cancel / Escape / backdrop click.
 *
 * Supported field types:
 *   - text     { name, label, placeholder?, defaultValue?, required? }
 *   - number   { name, label, min?, max?, step?, suffix?, defaultValue? }
 *   - select   { name, label, options: [{ value, label }], defaultValue? }
 *   - preview  { name, label?, html }   read-only rendered block
 *
 * Focus lands on the first interactive control on open and returns to
 * the trigger element on close. Tab wraps within the modal.
 */

let _genericModalOpen = false
let _genericModalCancel = null
let _lastFocusedBeforeModal = null

function _ensureGenericModal () {
  if (document.getElementById('generic-modal')) return
  const wrap = document.createElement('div')
  wrap.id = 'generic-modal'
  wrap.className = 'modal'
  wrap.setAttribute('role', 'dialog')
  wrap.setAttribute('aria-modal', 'true')
  wrap.setAttribute('aria-labelledby', 'generic-modal-title')
  wrap.hidden = true
  wrap.innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-panel generic-modal-panel">
      <button class="modal-close" data-close type="button" aria-label="Close">×</button>
      <div class="generic-modal-head">
        <div class="generic-modal-title" id="generic-modal-title"></div>
        <p class="generic-modal-desc" hidden></p>
      </div>
      <form class="generic-modal-body" novalidate></form>
      <div class="generic-modal-actions">
        <button type="button" class="btn ghost" data-role="cancel">Cancel</button>
        <button type="button" class="btn primary" data-role="submit">Confirm</button>
      </div>
    </div>
  `
  document.body.appendChild(wrap)
}

function _escapeAttr (v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _fieldToHTML (f, idx) {
  const inputId = `gmf-${(f.name || 'field').replace(/[^a-z0-9_-]/gi, '')}-${idx}`
  const labelHTML = f.label ? `<label for="${inputId}">${_escapeAttr(f.label)}</label>` : ''
  const suffix = f.suffix ? `<span class="suffix">${_escapeAttr(f.suffix)}</span>` : ''
  const wrapCls = 'generic-modal-field' + (f.suffix ? ' with-suffix' : '')

  if (f.type === 'preview') {
    return `<div class="${wrapCls}" data-field-name="${_escapeAttr(f.name || '')}">
      ${labelHTML}
      <div class="generic-modal-preview">${f.html || ''}</div>
    </div>`
  }
  if (f.type === 'select') {
    const opts = (f.options || []).map(o =>
      `<option value="${_escapeAttr(o.value)}" ${o.value === f.defaultValue ? 'selected' : ''}>${_escapeAttr(o.label)}</option>`
    ).join('')
    return `<div class="${wrapCls}" data-field-name="${_escapeAttr(f.name || '')}">
      ${labelHTML}
      <select id="${inputId}" name="${_escapeAttr(f.name)}">${opts}</select>
    </div>`
  }
  const type = f.type || 'text'
  const attrs = [
    `id="${inputId}"`,
    `name="${_escapeAttr(f.name)}"`,
    `type="${type}"`,
    f.placeholder != null ? `placeholder="${_escapeAttr(f.placeholder)}"` : '',
    f.min != null ? `min="${_escapeAttr(f.min)}"` : '',
    f.max != null ? `max="${_escapeAttr(f.max)}"` : '',
    f.step != null ? `step="${_escapeAttr(f.step)}"` : (type === 'number' ? 'step="0.01"' : ''),
    f.defaultValue != null ? `value="${_escapeAttr(f.defaultValue)}"` : '',
    'autocomplete="off"',
    type === 'number' ? 'inputmode="decimal"' : '',
  ].filter(Boolean).join(' ')
  return `<div class="${wrapCls}" data-field-name="${_escapeAttr(f.name || '')}">
    ${labelHTML}
    <input ${attrs} />${suffix}
  </div>`
}

function _validateFields (form, fields) {
  for (const f of fields) {
    if (f.type === 'preview') continue
    if (f.required === false) continue
    const el = form.elements[f.name]
    if (!el) continue
    const v = (el.value == null ? '' : String(el.value)).trim()
    if (!v) return false
    if (f.type === 'number') {
      const n = Number(v)
      if (!Number.isFinite(n)) return false
      if (f.min != null && n < Number(f.min)) return false
      if (f.max != null && n > Number(f.max)) return false
      if (f.min == null && n <= 0) return false
    }
  }
  return true
}

function _focusables (root) {
  return [...root.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter(el => !el.hidden && el.offsetParent !== null)
}

async function openModal ({ title, description, fields = [], submit = 'Confirm', cancel = 'Cancel' } = {}) {
  _ensureGenericModal()
  const root = document.getElementById('generic-modal')
  const titleEl = root.querySelector('.generic-modal-title')
  const descEl = root.querySelector('.generic-modal-desc')
  const body = root.querySelector('.generic-modal-body')
  const submitBtn = root.querySelector('[data-role="submit"]')
  const cancelBtn = root.querySelector('[data-role="cancel"]')

  titleEl.textContent = title || ''
  if (description) {
    descEl.hidden = false
    descEl.textContent = description
  } else {
    descEl.hidden = true
    descEl.textContent = ''
  }
  body.innerHTML = fields.map((f, i) => _fieldToHTML(f, i)).join('')
  submitBtn.textContent = submit
  cancelBtn.textContent = cancel
  // Hide the submit button when the caller passes an empty submit label:
  // some modals are read-only (details view) and having two identical
  // "Close" buttons is a UX smell. Cancel remains the single close path.
  submitBtn.hidden = !submit
  submitBtn.style.display = submit ? '' : 'none'

  _lastFocusedBeforeModal = document.activeElement
  root.hidden = false
  _genericModalOpen = true

  const revalidate = () => { submitBtn.disabled = !_validateFields(body, fields) }
  revalidate()
  body.addEventListener('input', revalidate)
  body.addEventListener('change', revalidate)

  // Focus first control (input/select) or fall back to the primary
  // action button. When submit is hidden (read-only view) we focus
  // Cancel instead so Esc/Enter still works and no dead focus lands
  // on a display:none button.
  const firstControl = body.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
    || (submit ? submitBtn : cancelBtn)
  setTimeout(() => { try { firstControl.focus() } catch {} }, 30)

  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      cleanup()
      resolve(value)
    }

    const onSubmit = () => {
      if (submitBtn.disabled) return
      const out = {}
      for (const f of fields) {
        if (f.type === 'preview') continue
        const el = body.elements[f.name]
        if (!el) continue
        out[f.name] = f.type === 'number' ? Number(el.value) : el.value
      }
      finish(out)
    }
    const onCancel = () => finish(null)
    const onBackdropClick = e => {
      const t = e.target
      if (t && t.dataset && Object.prototype.hasOwnProperty.call(t.dataset, 'close')) finish(null)
    }
    const onKey = e => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        finish(null)
        return
      }
      if (e.key === 'Enter' && document.activeElement && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'SELECT') {
        // Enter submits the form when valid. Skip when submit is hidden
        // (read-only modal): the only interactive action is Close.
        if (submit && !submitBtn.disabled) {
          e.preventDefault()
          onSubmit()
        }
        return
      }
      if (e.key === 'Tab') {
        // Focus trap: wrap around the interactive elements inside the panel.
        const f = _focusables(root)
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        const active = document.activeElement
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
      }
    }

    _genericModalCancel = () => finish(null)

    root.addEventListener('click', onBackdropClick)
    root.addEventListener('keydown', onKey)
    submitBtn.addEventListener('click', onSubmit)
    cancelBtn.addEventListener('click', onCancel)

    function cleanup () {
      root.hidden = true
      _genericModalOpen = false
      _genericModalCancel = null
      root.removeEventListener('click', onBackdropClick)
      root.removeEventListener('keydown', onKey)
      submitBtn.removeEventListener('click', onSubmit)
      cancelBtn.removeEventListener('click', onCancel)
      body.removeEventListener('input', revalidate)
      body.removeEventListener('change', revalidate)
      try { _lastFocusedBeforeModal?.focus?.() } catch {}
    }
  })
}

/* ─── Client-side USDt transfer via ethers (external mode) ─── */
async function transferUsdt (to, amount) {
  if (CONNECTED.mode !== 'external') throw new Error('Not in external mode')
  if (!CONFIG.usdt.address) throw new Error('USDT contract not configured on the server')
  const contract = new ethers.Contract(CONFIG.usdt.address, ERC20_ABI, CONNECTED.signer)
  const raw = ethers.parseUnits(String(amount), CONFIG.usdt.decimals)
  const tx = await contract.transfer(to, raw)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Tx reverted')
  return { hash: tx.hash, from: CONNECTED.address, to, amount: Number(amount), blockNumber: receipt.blockNumber }
}

/* ─── v2: Client-side ABIs + helpers for the three primitive contracts ─── */

const TIP_ROUTER_ABI = [
  'function tipTeam(string teamId, uint256 amount) external',
  'function tipPlayer(string teamId, string playerName, uint256 amount) external',
  'function teamAddress(string) view returns (address)',
]

const POOL_MANAGER_ABI = [
  'function createPool(string purpose, uint8 policy, string teamId, uint256 payoutTime) returns (uint256)',
  'function contribute(uint256 poolId, uint256 amount) external',
  'function pools(uint256) view returns (address creator, string purpose, uint8 policy, string teamId, uint256 totalUsdt, uint256 payoutTime, bool settled)',
  'function nextPoolId() view returns (uint256)',
  'event PoolCreated(uint256 indexed poolId, address indexed creator, string purpose, uint8 policy, string teamId, uint256 payoutTime)',
]

const MARKET_ABI = [
  'function openMarket(string matchId) external',
  'function placeBet(string matchId, uint8 outcome, uint256 amount) returns (uint256)',
  'function markets(string) view returns (string matchId, uint256 totalStake, uint256 stakeHome, uint256 stakeAway, uint256 stakeDraw, uint8 winning, uint8 status)',
  'event BetPlaced(uint256 indexed betId, address indexed bettor, string matchId, uint8 outcome, uint256 amount)',
]

const OUTCOME_ID = { home: 0, away: 1, draw: 2 }
const POLICY_ID = { equal: 0, proportional: 1, 'winner-takes': 2 }

/// Ensure USDT allowance for a given spender is at least `amountRaw`.
/// Idempotent: skips the approve() tx when the current allowance
/// already covers the amount. Returns the approve tx hash or null.
async function ensureAllowance (spender, amountRaw) {
  const usdt = new ethers.Contract(CONFIG.usdt.address, ERC20_ABI, CONNECTED.signer)
  const current = await usdt.allowance(CONNECTED.address, spender)
  if (current >= amountRaw) return null
  const tx = await usdt.approve(spender, ethers.MaxUint256)
  const receipt = await tx.wait()
  return { hash: tx.hash, blockNumber: receipt.blockNumber }
}

/// Client-side tip via FanTipRouter. One approve tx (first time only)
/// followed by one tipTeam call. Returns the ethers TransactionResponse
/// so callers can pass tx.hash to the audit journal + toast.
async function clientTipTeam (teamId, amount) {
  if (CONNECTED.mode !== 'external') throw new Error('Not in external mode')
  const problems = []
  if (!CONFIG.contracts?.tipRouter) problems.push('CONFIG.contracts.tipRouter')
  if (!CONFIG.usdt?.address) problems.push('CONFIG.usdt.address')
  if (!CONFIG.usdt?.decimals) problems.push('CONFIG.usdt.decimals')
  if (!CONNECTED.signer) problems.push('CONNECTED.signer')
  if (!teamId) problems.push('teamId')
  if (problems.length) {
    console.error('[fanbank] tipTeam preflight FAIL:', { problems, CONFIG, CONNECTED, teamId, amount })
    throw new Error(`Missing values for tip: ${problems.join(', ')}. Hard refresh (Ctrl+Shift+R) and reconnect.`)
  }
  const raw = ethers.parseUnits(String(amount), CONFIG.usdt.decimals)
  const approvalReceipt = await ensureAllowance(CONFIG.contracts.tipRouter, raw)
  const router = new ethers.Contract(CONFIG.contracts.tipRouter, TIP_ROUTER_ABI, CONNECTED.signer)
  const tx = await router.tipTeam(teamId, raw)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Tip reverted on chain')
  return { hash: tx.hash, blockNumber: receipt.blockNumber, from: CONNECTED.address, approvalHash: approvalReceipt?.hash ?? null, amount: Number(amount) }
}

async function clientTipPlayer (teamId, playerName, amount) {
  if (CONNECTED.mode !== 'external') throw new Error('Not in external mode')
  // Defensive: if any of these are null the ethers Contract() will throw
  // an opaque target=null. Fail fast with a clear message + console dump
  // so a future regression is diagnosable in one glance at DevTools.
  const problems = []
  if (!CONFIG.contracts?.tipRouter) problems.push('CONFIG.contracts.tipRouter')
  if (!CONFIG.usdt?.address) problems.push('CONFIG.usdt.address')
  if (!CONFIG.usdt?.decimals) problems.push('CONFIG.usdt.decimals')
  if (!CONNECTED.signer) problems.push('CONNECTED.signer')
  if (!teamId) problems.push('teamId')
  if (!playerName) problems.push('playerName')
  if (problems.length) {
    console.error('[fanbank] tipPlayer preflight FAIL:', { problems, CONFIG, CONNECTED, teamId, playerName, amount })
    throw new Error(`Missing values for tip: ${problems.join(', ')}. Hard refresh (Ctrl+Shift+R) and reconnect.`)
  }
  const raw = ethers.parseUnits(String(amount), CONFIG.usdt.decimals)
  const approvalReceipt = await ensureAllowance(CONFIG.contracts.tipRouter, raw)
  const router = new ethers.Contract(CONFIG.contracts.tipRouter, TIP_ROUTER_ABI, CONNECTED.signer)
  const tx = await router.tipPlayer(teamId, playerName, raw)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Tip reverted on chain')
  return { hash: tx.hash, blockNumber: receipt.blockNumber, from: CONNECTED.address, approvalHash: approvalReceipt?.hash ?? null, amount: Number(amount) }
}

async function clientContribute (poolId, amount) {
  if (CONNECTED.mode !== 'external') throw new Error('Not in external mode')
  if (!CONFIG.contracts?.poolManager) throw new Error('FanPoolManager address missing')
  const raw = ethers.parseUnits(String(amount), CONFIG.usdt.decimals)
  const approvalReceipt = await ensureAllowance(CONFIG.contracts.poolManager, raw)
  const pm = new ethers.Contract(CONFIG.contracts.poolManager, POOL_MANAGER_ABI, CONNECTED.signer)
  const tx = await pm.contribute(poolId, raw)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Contribution reverted on chain')
  return { hash: tx.hash, blockNumber: receipt.blockNumber, from: CONNECTED.address, approvalHash: approvalReceipt?.hash ?? null, amount: Number(amount) }
}

async function clientPlaceBet (matchId, outcome, amount) {
  if (CONNECTED.mode !== 'external') throw new Error('Not in external mode')
  if (!CONFIG.contracts?.market) throw new Error('ParimutuelMarket address missing')
  const raw = ethers.parseUnits(String(amount), CONFIG.usdt.decimals)
  const approvalReceipt = await ensureAllowance(CONFIG.contracts.market, raw)
  const market = new ethers.Contract(CONFIG.contracts.market, MARKET_ABI, CONNECTED.signer)
  const tx = await market.placeBet(matchId, OUTCOME_ID[outcome] ?? 0, raw)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Bet reverted on chain')
  return { hash: tx.hash, blockNumber: receipt.blockNumber, from: CONNECTED.address, approvalHash: approvalReceipt?.hash ?? null, amount: Number(amount), outcome, matchId }
}

/* ─── Stats strip ─── */
async function refreshStats () {
  try {
    // Read stats off the merged journal so a reset click that only cleared
    // one Lambda instance still zeroes the display, and so post-reset
    // events push the counters back up in real time.
    const [journal] = await Promise.all([
      api('/api/journal').then(r => r.entries || []).catch(() => []),
    ])
    const resetAt = loadResetAt()
    const seen = new Set()
    const merged = []
    for (const e of [...journal, ...loadClientEvents()]) {
      if (resetAt && (e.ts || 0) < resetAt) continue
      const key = e.hash || `${e.type}:${e.matchId || e.poolId || ''}:${e.ts || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(e)
    }
    let tipCount = 0, tipVol = 0, betCount = 0, betVol = 0
    for (const e of merged) {
      if (e.type === 'tip') { tipCount++; tipVol += Number(e.amount || 0) }
      else if (e.type === 'bet-placed') { betCount++; betVol += Number(e.amount || 0) }
    }
    $('#stat-tips').textContent = String(tipCount)
    $('#stat-tip-vol').textContent = fmtUsdt(tipVol)
    $('#stat-bets').textContent = String(betCount)
    $('#stat-bet-vol').textContent = fmtUsdt(betVol)
  } catch { /* keep previous */ }
}

/* ─── Custom dropdown ───
 *
 * The panel is portaled to document.body on init so it lives outside any
 * ancestor stacking context. Panels inside cards with backdrop-filter
 * blur were being clipped and rendered under the following section, even
 * with position: fixed + z-index: 200, because backdrop-filter (like
 * transform / filter) creates a new stacking context that traps fixed
 * descendants. Portaling escapes that entirely.
 */
function initDropdown (root, options, onChange, { placeholder, defaultValue } = {}) {
  const btn = root.querySelector('.dd-btn')
  const cur = root.querySelector('.dd-current')

  // Take ownership of the panel and move it under document.body. From now
  // on the panel is a global overlay; the parent .dropdown only tracks
  // "open" state via a CSS class and positions the panel from JS.
  const originalPanel = root.querySelector('.dd-panel')
  const panel = document.createElement('div')
  panel.className = 'dd-panel dd-panel-portal'
  panel.setAttribute('role', 'listbox')
  originalPanel?.remove()
  document.body.appendChild(panel)

  let current = null
  let isOpen = false

  function positionPanel () {
    const rect = btn.getBoundingClientRect()
    panel.style.left = rect.left + 'px'
    panel.style.top = (rect.bottom + 6) + 'px'
    panel.style.width = rect.width + 'px'
  }

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
    close()
    onChange && onChange(value, opt)
  }
  function open () {
    // Close every other dropdown first so only one is ever visible.
    for (const other of document.querySelectorAll('.dropdown.open')) {
      if (other !== root) other._closeDD?.()
    }
    render()
    positionPanel()
    root.classList.add('open')
    panel.classList.add('open')
    isOpen = true
  }
  function close () {
    root.classList.remove('open')
    panel.classList.remove('open')
    isOpen = false
  }
  root._closeDD = close

  cur.textContent = placeholder || 'Pick one'

  btn.addEventListener('click', e => {
    e.stopPropagation()
    if (isOpen) close(); else open()
  })
  document.addEventListener('click', e => {
    if (!isOpen) return
    if (panel.contains(e.target) || btn.contains(e.target)) return
    close()
  })
  window.addEventListener('scroll', () => { if (isOpen) positionPanel() }, true)
  window.addEventListener('resize', () => { if (isOpen) positionPanel() })

  if (defaultValue !== undefined) select(defaultValue)
  return { select, getValue: () => current }
}

let tipTeamDD, tipPlayerDD, poolTeamDD, poolPolicyDD
let TIP_MODE = 'team' // 'team' | 'player'

/* ─── Tip flow ─── */
async function submitTip () {
  const teamId = tipTeamDD.getValue()
  const playerName = TIP_MODE === 'player' ? tipPlayerDD?.getValue() : null
  const amount = Number($('#tip-amount').value)
  const hint = $('#tip-hint')
  if (!teamId) { hint.className = 'hint err'; hint.textContent = 'Pick a team first.'; return }
  if (TIP_MODE === 'player' && !playerName) { hint.className = 'hint err'; hint.textContent = 'Pick a player first.'; return }
  if (!amount || amount <= 0) { hint.className = 'hint err'; hint.textContent = 'Amount must be positive.'; return }

  const btn = $('#tip-btn')
  const originalBtnHTML = btn.innerHTML
  btn.disabled = true
  btn.innerHTML = '<span class="btn-spinner"></span> Waiting for wallet...'
  hint.className = 'hint'
  hint.textContent = 'Waiting for wallet...'

  try {
    await ensureConnected()
    const team = TEAMS.find(t => t.id === teamId)
    const player = playerName ? (team?.players || []).find(p => p.name === playerName) : null
    const shortage = preflightSpend(amount)
    if (shortage) throw new Error(shortage)
    let receipt
    const targetLabel = TIP_MODE === 'player' ? `${playerName} (${team.name})` : team.name
    const targetAddress = TIP_MODE === 'player' ? (player?.tipAddress || null) : team.tipAddress

    if (CONNECTED.mode === 'external') {
      await ensureCorrectChain()
      hint.textContent = `Signing tip to ${targetLabel} via FanTipRouter…`
      const res = TIP_MODE === 'player'
        ? await clientTipPlayer(teamId, playerName, amount)
        : await clientTipTeam(teamId, amount)
      hint.textContent = 'Tx sent, confirming…'
      receipt = res
      const endpoint = TIP_MODE === 'player' ? '/api/tip/player/external' : '/api/tip/team/external'
      const body = TIP_MODE === 'player'
        ? { teamId, playerName, amount, txHash: res.hash, from: res.from, to: targetAddress, approvalHash: res.approvalHash, router: CONFIG.contracts?.tipRouter }
        : { teamId, amount, txHash: res.hash, from: res.from, to: targetAddress, approvalHash: res.approvalHash, router: CONFIG.contracts?.tipRouter }
      await api(endpoint, { method: 'POST', body }).catch(() => {}) // journal is best-effort
    } else {
      const path = TIP_MODE === 'player' ? '/api/tip/player' : '/api/tip/team'
      const body = TIP_MODE === 'player' ? { teamId, playerName, amount } : { teamId, amount }
      const r = await api(path, { method: 'POST', body })
      receipt = r.receipt
    }
    pushClientEvent({
      type: 'tip',
      target: TIP_MODE,
      teamId: team.id,
      teamName: team.name,
      playerName: playerName ?? undefined,
      amount,
      from: receipt.from,
      to: targetAddress,
      hash: receipt.hash,
    })
    hint.className = 'hint ok'
    hint.textContent = `Tipped ${fmtUsdt(amount)} to ${targetLabel}. Tx ${shortHash(receipt.hash)}.`
    toast({ level: 'ok', title: `Tipped ${fmtUsdt(amount)} to ${targetLabel}`, txHash: receipt.hash })
    $('#tip-amount').value = ''
    Promise.all([refreshConnectedBalances(), refreshStats(), refreshJournal()]).catch(() => {})
  } catch (e) {
    const msg = friendlyError(e)
    hint.className = 'hint err'
    hint.textContent = msg
    toast({ level: 'err', title: 'Tip failed', desc: msg })
  } finally {
    btn.disabled = false
    btn.innerHTML = originalBtnHTML
  }
}

/// Rebuild the player dropdown to the players of the currently selected
/// tip team. Called when either the team dropdown changes or the user
/// flips the segmented toggle to "Player".
function refreshTipPlayerDD () {
  const teamId = tipTeamDD?.getValue()
  const team = TEAMS.find(t => t.id === teamId)
  const players = team?.players || []
  const options = players.length
    ? players.map(p => ({ value: p.name, label: p.name, sub: p.tipAddress ? shortAddr(p.tipAddress) : '' }))
    : [{ value: '', label: 'No players registered for this team' }]
  const wrap = $('[data-dropdown="tip-player"]')
  if (!wrap) return
  // Rebuild by clearing and re-init. Cheaper than an in-place update
  // because the dropdown owns its portaled panel node under document.body.
  wrap.innerHTML = `
    <button class="dd-btn" type="button">
      <span class="dd-current">${team ? 'Pick a player' : 'Pick a team first'}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="dd-panel" role="listbox"></div>
  `
  tipPlayerDD = initDropdown(wrap, options, () => {}, { placeholder: team ? 'Pick a player' : 'Pick a team first' })
}

function setTipMode (mode) {
  TIP_MODE = mode === 'player' ? 'player' : 'team'
  $$('[data-tip-mode]').forEach(b => {
    const active = b.dataset.tipMode === TIP_MODE
    b.classList.toggle('active', active)
    b.setAttribute('aria-selected', active ? 'true' : 'false')
  })
  const playerField = $('.field-player')
  if (playerField) playerField.hidden = TIP_MODE !== 'player'
  const hint = $('#tip-hint')
  if (hint) { hint.className = 'hint'; hint.textContent = '' }
  if (TIP_MODE === 'player') refreshTipPlayerDD()
}

/* ─── Pool flow ─── */
async function submitPool () {
  const purpose = $('#pool-purpose').value.trim()
  const policy = poolPolicyDD.getValue() || 'equal'
  const teamId = poolTeamDD.getValue() || null
  if (!purpose) return toast({ level: 'err', title: 'Pool needs a purpose' })

  // Instant feedback: disable the button and show inline progress so the
  // user knows the click was received. The server signs an on-chain
  // createPool tx which can take 2-4s on Sepolia; without this the
  // button looks dead until the toast pops.
  const btn = $('#pool-create-btn')
  const originalLabel = btn.textContent
  btn.disabled = true
  btn.innerHTML = '<span class="btn-spinner"></span> Opening pool...'
  const toastId = toast({ level: 'ok', title: 'Opening pool...', desc: purpose, timeout: 30_000 })

  try {
    const r = await api('/api/pool/create', { method: 'POST', body: { teamId, purpose, policy } })
    $('#pool-purpose').value = ''
    pushClientEvent({
      type: 'pool-created',
      poolId: r.poolId,
      teamId,
      teamName: (TEAMS.find(t => t.id === teamId) || {}).name,
      purpose,
      policy,
      hash: 'local:pool:' + r.poolId,
    })
    dismissToast(toastId)
    toast({ level: 'ok', title: 'Pool opened', desc: purpose })
    // Non-blocking refresh so the toast + button reset feel instant.
    Promise.all([refreshPools(), refreshJournal()]).catch(() => {})
  } catch (e) {
    dismissToast(toastId)
    toast({ level: 'err', title: 'Pool creation failed', desc: friendlyError(e) })
  } finally {
    btn.disabled = false
    btn.textContent = originalLabel
  }
}

async function refreshPools () {
  try {
    // Compute pools purely from the merged journal (server + local, dedup
    // by hash). Trying to reconcile /api/pools with a separate
    // /api/journal read fails on Vercel because the two endpoints can
    // resolve to different Lambda instances with different /tmp state.
    // Reading everything from one merged event log fixes that.
    const [journal, localEvents] = await Promise.all([
      api('/api/journal').then(r => r.entries || []).catch(() => []),
      Promise.resolve(loadClientEvents()),
    ])
    const resetAt = loadResetAt()
    const seen = new Set()
    const merged = []
    for (const e of [...journal, ...localEvents]) {
      if (resetAt && (e.ts || 0) < resetAt) continue
      const key = e.hash || `${e.type}:${e.poolId || ''}:${e.ts || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(e)
    }
    // The server returns entries newest-first and the local cache is
    // append-order, so a naive iteration can process a pool-contribution
    // before its parent pool-created and drop the total on the floor.
    // Sort ascending by ts so causality is respected: pool created,
    // then contributed to, then settled.
    merged.sort((a, b) => (a.ts || 0) - (b.ts || 0))
    const poolsMap = new Map()
    for (const e of merged) {
      if (e.type === 'pool-created') {
        // First pool-created for this poolId wins. A later duplicate
        // (server + local with different ts) would otherwise overwrite
        // the pool object and wipe any contributions accumulated so far.
        if (!poolsMap.has(e.poolId)) {
          poolsMap.set(e.poolId, {
            poolId: e.poolId,
            teamId: e.teamId,
            teamName: e.teamName,
            purpose: e.purpose,
            policy: e.policy,
            totalUsdt: 0,
            contributors: new Set(),
            settled: false,
          })
        }
      } else if (e.type === 'pool-contribution' && (e.status || 'success') === 'success') {
        const p = poolsMap.get(e.poolId)
        if (p) {
          p.totalUsdt += Number(e.amount || 0)
          if (e.from) p.contributors.add(e.from)
        }
      } else if (e.type === 'pool-settled') {
        const p = poolsMap.get(e.poolId)
        if (p) p.settled = true
      }
    }
    const hidden = loadHiddenPools()
    const pools = [...poolsMap.values()]
      .filter(p => !hidden.has(String(p.poolId)))
      .map(p => ({
        ...p,
        contributors: p.contributors.size,
      }))
    const root = $('#pools-list')
    if (!pools.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-icon">🏦</div><div class="empty-title">No pools yet</div><div class="empty-desc">Open one above for a watch-party, a shared gift for a player, or a savings club.</div></div>`
      return
    }
    root.innerHTML = pools.map(p => {
      const team = TEAMS.find(t => t.id === p.teamId)
      return `
        <div class="pool-row">
          <div>
            <div class="pool-title-line">
              <span class="pool-title">${p.purpose || '(no purpose)'}</span>
              <button class="pool-info-icon" data-details="${p.poolId}" aria-label="View pool details" title="View pool details">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              </button>
            </div>
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
    $$('button[data-details]').forEach(b => b.addEventListener('click', () => openPoolDetails(b.dataset.details)))
  } catch (e) {
    toast({ level: 'err', title: 'Pool list failed', desc: e.message })
  }
}

/// Detailed pool view. Reads on-chain state (creator, purpose, policy,
/// team, total, settled flag) and the merged journal to rebuild a
/// timeline of contributions. Ships a Remove-from-view action that maps
/// to the same hidePool() the row-level cross used, but scoped to a
/// full modal so a judge can inspect the pool before deleting it.
async function openPoolDetails (poolId) {
  const numeric = Number(poolId)
  let onChain = null
  try {
    if (CONFIG.contracts?.poolManager) {
      const provider = CONNECTED?.provider || new ethers.JsonRpcProvider(CONFIG.rpcHttp || 'https://sepolia.base.org')
      const pm = new ethers.Contract(CONFIG.contracts.poolManager, POOL_MANAGER_ABI, provider)
      const raw = await pm.pools(numeric)
      const policyId = Number(raw.policy ?? raw[2])
      onChain = {
        creator: raw.creator ?? raw[0],
        purpose: raw.purpose ?? raw[1],
        policy: ['equal', 'proportional', 'winner-takes'][policyId] || 'unknown',
        teamId: raw.teamId ?? raw[3],
        totalUsdt: Number(ethers.formatUnits(raw.totalUsdt ?? raw[4], CONFIG.usdt.decimals)),
        payoutTime: Number(raw.payoutTime ?? raw[5]),
        settled: Boolean(raw.settled ?? raw[6]),
      }
    }
  } catch (e) {
    console.warn('[fanbank] pool on-chain read failed:', e?.message)
  }

  // Local + server journal to build a chronological event list for the pool.
  const journal = await api('/api/journal').then(r => r.entries || []).catch(() => [])
  const events = [...journal, ...loadClientEvents()]
    .filter(e => (e.poolId === poolId || Number(e.poolId) === numeric) && (e.status || 'success') === 'success')
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
  const created = events.find(e => e.type === 'pool-created')
  const contributions = events.filter(e => e.type === 'pool-contribution')
  const payouts = events.filter(e => e.type === 'pool-payout' || e.type === 'pool-settled')

  const team = onChain?.teamId ? TEAMS.find(t => t.id === onChain.teamId) : null
  const explorer = CONFIG?.explorer || 'https://sepolia.basescan.org'
  const linkAddr = a => a ? `<a href="${explorer}/address/${a}" target="_blank" rel="noopener">${shortAddr(a)}</a>` : '<span class="mono">-</span>'
  const linkTx = h => h && !String(h).startsWith('local:')
    ? `<a href="${explorer}/tx/${h}" target="_blank" rel="noopener">${shortHash(h)} ↗</a>`
    : '<span class="mono">off-chain</span>'
  const fmtDate = ts => ts ? new Date(ts).toLocaleString() : '-'
  const payoutTimeLabel = onChain?.payoutTime
    ? (onChain.payoutTime > 0 ? new Date(onChain.payoutTime * 1000).toLocaleString() : 'no deadline')
    : '-'

  const contributionsHTML = contributions.length
    ? `<div class="pool-timeline">${contributions.map(c => `
        <div class="pool-timeline-row">
          <span class="who">${linkAddr(c.from)}<span class="ts">${timeAgo(c.ts)}</span></span>
          <span class="amt">+${fmtUsdt(c.amount)}</span>
        </div>
      `).join('')}</div>`
    : '<div class="pool-empty-row">No contributions yet.</div>'

  const payoutsHTML = payouts.length
    ? `<div class="pool-timeline">${payouts.map(p => `
        <div class="pool-timeline-row">
          <span class="who">${p.type === 'pool-settled' ? `Settled via ${p.policy}` : linkAddr(p.to)}<span class="ts">${timeAgo(p.ts)}</span></span>
          <span class="amt">${p.type === 'pool-settled' ? `${p.payouts || 0} recipients` : fmtUsdt(p.amount)}</span>
        </div>
      `).join('')}</div>`
    : '<div class="pool-empty-row">No payout yet.</div>'

  const purposeLabel = onChain?.purpose || created?.purpose || `#${numeric}`
  const statusLabel = onChain?.settled ? 'Settled' : 'Open'
  const statusClass = onChain?.settled ? 'settled' : 'open'

  const detailsHTML = `
    <div class="pool-details">
      <div class="pool-details-header">
        <div class="pool-title-block">
          <div class="title">${purposeLabel}</div>
          <div class="subtitle">Pool #${numeric} · ${onChain?.policy || created?.policy || '?'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <span class="status-pill ${statusClass}">${statusLabel}</span>
          <button type="button" class="btn-danger-inline" data-pool-remove="${_escapeAttr(String(poolId))}" title="Remove pool from view">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/></svg>
            Remove
          </button>
        </div>
      </div>

      <dl class="pool-details-grid">
        <dt>Team</dt><dd>${team ? team.name : (onChain?.teamId || 'None')}</dd>
        <dt>Total pooled</dt><dd>${fmtUsdt(onChain?.totalUsdt ?? 0)}</dd>
        <dt>Contributors</dt><dd>${new Set(contributions.map(c => c.from).filter(Boolean)).size}</dd>
        <dt>Creator</dt><dd>${linkAddr(onChain?.creator)}</dd>
        <dt>Created</dt><dd>${fmtDate(created?.ts)}</dd>
        <dt>Payout deadline</dt><dd>${payoutTimeLabel}</dd>
      </dl>

      <div class="pool-section">
        <div class="pool-section-title">Contributions</div>
        ${contributionsHTML}
      </div>
      <div class="pool-section">
        <div class="pool-section-title">Payouts</div>
        ${payoutsHTML}
      </div>
    </div>
  `

  // Wire the inline red Remove button on the next microtask, once the
  // modal body has been written to the DOM by openModal.
  queueMicrotask(() => {
    const removeBtn = document.querySelector('#generic-modal [data-pool-remove]')
    if (!removeBtn) return
    removeBtn.addEventListener('click', () => {
      hidePool(removeBtn.dataset.poolRemove)
      toast({ level: 'ok', title: 'Pool removed from view', desc: 'On-chain contributions still verifiable on Basescan.' })
      refreshPools().catch(() => {})
      _genericModalCancel?.()
    })
  })

  await openModal({
    title: 'Pool details',
    description: 'Full on-chain state and audit trail for this pool.',
    fields: [
      { name: '_pool_details', type: 'preview', html: detailsHTML },
    ],
    submit: '',
    cancel: 'Close',
  })
}

async function contributeToPool (poolId) {
  const values = await openModal({
    title: 'Contribute to pool',
    description: 'Signs a USDt transfer from your wallet into the pool escrow.',
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', placeholder: '1.00', min: 0.01, step: 0.01, suffix: 'USDt' },
    ],
    submit: 'Send contribution',
  })
  if (!values) return
  const amount = Number(values.amount)
  try {
    await ensureConnected()
    const shortage = preflightSpend(amount)
    if (shortage) throw new Error(shortage)
    let receipt
    if (CONNECTED.mode === 'external') {
      await ensureCorrectChain()
      receipt = await clientContribute(Number(poolId), amount)
      await api(`/api/pool/${poolId}/contribute/external`, { method: 'POST', body: {
        amount, txHash: receipt.hash, from: receipt.from, to: CONFIG.contracts?.poolManager,
        approvalHash: receipt.approvalHash, manager: CONFIG.contracts?.poolManager,
      } })
    } else {
      const r = await api(`/api/pool/${poolId}/contribute`, { method: 'POST', body: { amount } })
      receipt = r.receipt
    }
    pushClientEvent({
      type: 'pool-contribution',
      poolId,
      amount,
      from: receipt.from,
      to: CONFIG.contracts?.poolManager,
      hash: receipt.hash,
    })
    toast({ level: 'ok', title: `Contributed ${fmtUsdt(amount)}`, txHash: receipt.hash })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Contribution failed', desc: friendlyError(e) })
  }
}

async function payoutPool (poolId) {
  try {
    const { split, policy, totalUsdt } = await api(`/api/pool/${poolId}/split`)
    if (!split.length) return toast({ level: 'err', title: 'Nothing to split yet' })
    const previewHTML = split.map(s => `
      <div class="generic-modal-preview-row">
        <span class="to">${shortAddr(s.address)}</span>
        <span class="amount">${fmtUsdt(s.amountUsdt)}</span>
      </div>
    `).join('')
    const values = await openModal({
      title: 'Confirm payout',
      description: `Sending ${fmtUsdt(totalUsdt)} using the "${policy}" policy across ${split.length} recipients.`,
      fields: [
        { name: '_preview', type: 'preview', label: 'Split preview', html: previewHTML },
      ],
      submit: 'Send payouts',
    })
    if (!values) return
    // Pool payout always flows from the operator's server-side WDK wallet
    // (it holds the pooled USDt). Operators and judges can flip this later.
    await api(`/api/pool/${poolId}/payout`, { method: 'POST', body: {} })
    toast({ level: 'ok', title: 'Pool paid out', desc: `${fmtUsdt(totalUsdt)} across ${split.length} recipients` })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Payout failed', desc: friendlyError(e) })
  }
}

/* ─── Markets ─── */
async function refreshMarkets () {
  try {
    // Same rationale as refreshPools: compute the market state from a
    // merged journal (server + local, dedup by hash) so a bet placed on
    // one Lambda instance still shows up when the next /api/markets read
    // lands on a fresh instance with empty /tmp.
    const [journal] = await Promise.all([
      api('/api/journal').then(r => r.entries || []).catch(() => []),
    ])
    const localEvents = loadClientEvents()
    const resetAt = loadResetAt()
    const seen = new Set()
    const merged = []
    for (const e of [...journal, ...localEvents]) {
      if (resetAt && (e.ts || 0) < resetAt) continue
      const key = e.hash || `${e.type}:${e.matchId || ''}:${e.ts || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(e)
    }
    const bets = merged.filter(e => e.type === 'bet-placed' && (e.status || 'success') === 'success')
    // Build a market row per known match. MATCHES is populated at boot
    // from /api/matches which is deterministic (static schedule), so
    // shape it here rather than trusting /api/markets aggregations.
    const markets = MATCHES.map(m => {
      const stakeByOutcome = { home: 0, away: 0, draw: 0 }
      let total = 0
      let count = 0
      for (const b of bets) {
        if (b.matchId !== m.id) continue
        const amt = Number(b.amount || 0)
        if (!amt) continue
        total += amt
        stakeByOutcome[b.outcome] = (stakeByOutcome[b.outcome] || 0) + amt
        count++
      }
      const odds = {}
      for (const k of ['home', 'away', 'draw']) {
        odds[k] = stakeByOutcome[k] > 0 ? total / stakeByOutcome[k] : null
      }
      return {
        matchId: m.id,
        matchLabel: `${m.home} vs ${m.away}`,
        status: m.status,
        resultOutcome: m.resultOutcome,
        resultScore: m.resultScore,
        totalStakeUsdt: total,
        betsCount: count,
        stakeByOutcome,
        odds,
      }
    })
    const root = $('#markets-list')
    if (!markets.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-icon">⚽</div><div class="empty-title">No matches loaded</div><div class="empty-desc">The schedule endpoint returned no upcoming fixtures. Check /api/matches.</div></div>`
      return
    }
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
  const oddStr = odd ? `×${odd.toFixed(2)}` : '×…'
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
  const match = MATCHES.find(x => x.id === matchId) || {}
  const home = TEAMS.find(t => t.id === match.home)
  const away = TEAMS.find(t => t.id === match.away)
  const outcomeLabel = outcome === 'home' ? (home?.name || 'Home wins')
                     : outcome === 'away' ? (away?.name || 'Away wins')
                     : 'Draw'
  const matchLabel = home && away ? `${home.name} vs ${away.name}` : (match.id || matchId)

  const values = await openModal({
    title: `Bet on ${outcomeLabel}`,
    description: `${matchLabel}. Signs a USDt transfer from your wallet into the market escrow.`,
    fields: [
      { name: 'amount', label: 'Stake', type: 'number', placeholder: '1.00', min: 0.01, step: 0.01, suffix: 'USDt' },
    ],
    submit: 'Place bet',
  })
  if (!values) return
  const amount = Number(values.amount)
  try {
    await ensureConnected()
    const shortage = preflightSpend(amount)
    if (shortage) throw new Error(shortage)
    let receipt
    if (CONNECTED.mode === 'external') {
      await ensureCorrectChain()
      receipt = await clientPlaceBet(matchId, outcome, amount)
      await api('/api/bet/external', { method: 'POST', body: {
        matchId, outcome, amount, txHash: receipt.hash, from: receipt.from,
        to: CONFIG.contracts?.market, approvalHash: receipt.approvalHash,
        market: CONFIG.contracts?.market,
      } })
    } else {
      const r = await api('/api/bet', { method: 'POST', body: { matchId, outcome, amount } })
      receipt = r.receipt
    }
    pushClientEvent({
      type: 'bet-placed',
      matchId,
      // Store matchLabel using team IDs the same way the server does,
      // so the audit journal renders proper flags via matchLabelWithFlags.
      matchLabel: `${match.home} vs ${match.away}`,
      matchStage: match.stage,
      outcome,
      amount,
      from: receipt.from,
      to: CONFIG.contracts?.market,
      hash: receipt.hash,
    })
    toast({ level: 'ok', title: `Bet placed: ${fmtUsdt(amount)} on ${outcomeLabel}`, txHash: receipt.hash })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshMarkets(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Bet failed', desc: friendlyError(e) })
  }
}

/// Ensure the server journal has every locally-cached bet before we ask
/// it to settle a market. Vercel serverless can route /api/bet/external
/// and the eventual /api/market/:id/settle to different Lambda instances
/// (each with its own /tmp journal), so the settle can end up seeing zero
/// bets and pay nobody. Replaying the local cache into the server right
/// before settle forces the same instance to have the full set.
async function syncLocalBetsToServer (matchId) {
  const local = loadClientEvents().filter(e =>
    e.type === 'bet-placed' && e.matchId === matchId && e.hash
  )
  if (!local.length) return
  let serverHashes = new Set()
  try {
    const { entries } = await api('/api/journal')
    for (const e of entries || []) if (e.hash) serverHashes.add(e.hash)
  } catch { /* offline: still worth trying the replay */ }
  const missing = local.filter(e => !serverHashes.has(e.hash))
  for (const b of missing) {
    try {
      await api('/api/bet/external', { method: 'POST', body: {
        matchId: b.matchId,
        outcome: b.outcome,
        amount: b.amount,
        txHash: b.hash,
        from: b.from,
        to: b.to,
      } })
    } catch { /* server may reject duplicate; ignore */ }
  }
}

async function settleDemoDialog (matchId) {
  const match = MATCHES.find(x => x.id === matchId) || {}
  const home = TEAMS.find(t => t.id === match.home)
  const away = TEAMS.find(t => t.id === match.away)
  const values = await openModal({
    title: 'Settle demo market',
    description: 'Judges only. Records a fake result and triggers payouts for the winning side.',
    fields: [
      { name: 'outcome', label: 'Result', type: 'select', defaultValue: 'home', options: [
        { value: 'home', label: `${home?.name || match.home || 'home'} wins` },
        { value: 'draw', label: 'Draw' },
        { value: 'away', label: `${away?.name || match.away || 'away'} wins` },
      ] },
      { name: 'score', label: 'Final score', type: 'text', placeholder: '2-1', required: false },
    ],
    submit: 'Settle market',
  })
  if (!values) return
  const toastId = toast({ level: 'ok', title: 'Settling market...', desc: `${home?.name || match.home} vs ${away?.name || match.away}`, timeout: 30_000 })
  try {
    await syncLocalBetsToServer(matchId)
    await api(`/api/match/${matchId}/settle-demo`, { method: 'POST', body: {
      outcome: values.outcome,
      score: values.score && values.score.trim() ? values.score.trim() : null,
    } })
    const r = await api(`/api/market/${matchId}/settle`, { method: 'POST' })
    dismissToast(toastId)
    toast({ level: 'ok', title: 'Market settled', desc: `${r.payouts} payouts, ${fmtUsdt(r.netPoolUsdt)} distributed` })
  } catch (e) {
    dismissToast(toastId)
    const msg = String(e?.message || '')
    // Contract already settled: NOT a hard error. The state we wanted
    // is already what the chain has. Toast an info message and force a
    // schedule reload so the UI catches up with the on-chain truth.
    if (/already settled/i.test(msg)) {
      toast({ level: 'ok', title: 'Market already settled', desc: 'On-chain result already recorded. Refreshing view.' })
    } else {
      toast({ level: 'err', title: 'Settle failed', desc: friendlyError(e) })
      return
    }
  }
  // Always reload matches so the UI reflects the new status. Without
  // this, MATCHES stays with status="scheduled" and the row keeps its
  // Settle demo button, so a second click hits "already settled".
  await loadMatches().catch(() => {})
  await Promise.all([refreshConnectedBalances(), refreshStats(), refreshMarkets(), refreshJournal()])
}

/* ─── Journal ─── */
async function refreshJournal () {
  try {
    const { entries } = await api('/api/journal')
    // Fold local optimistic events the server has not yet reflected so
    // the audit table stays in sync with what the user just did.
    const resetAt = loadResetAt()
    const filteredEntries = (entries || []).filter(e => !resetAt || (e.ts || 0) >= resetAt)
    const seen = new Set(filteredEntries.map(e => e.hash).filter(Boolean))
    const pending = loadClientEvents().filter(e =>
      e.hash && !seen.has(e.hash) && (!resetAt || (e.ts || 0) >= resetAt)
    )
    const merged = [...filteredEntries, ...pending].sort((a, b) => (b.ts || 0) - (a.ts || 0))
    const root = $('#journal')
    if (!merged.length) {
      root.innerHTML = `<div class="empty-state"><div class="empty-icon">📓</div><div class="empty-title">Journal empty</div><div class="empty-desc">Every tip, pool contribution, and bet lands here with its on-chain tx hash.</div></div>`
      return
    }
    root.innerHTML = merged.slice(0, 60).map(e => {
      // Local-only markers (pool creation, other off-chain events cached
      // client-side) carry a synthetic hash like "local:pool:pool_xxx".
      // Do not render those as Etherscan links because there is no tx.
      const isRealTx = e.hash && !String(e.hash).startsWith('local:')
      return `
        <div class="journal-row">
          <span class="journal-ts">${timeAgo(e.ts)}</span>
          <span class="journal-type">${e.type}</span>
          <span class="journal-desc">${describeEvent(e)}</span>
          ${isRealTx
            ? `<a class="journal-hash" href="${CONFIG?.explorer}/tx/${e.hash}" target="_blank" rel="noopener">${shortHash(e.hash)} ↗</a>`
            : '<span class="journal-hash">off-chain</span>'}
        </div>
      `
    }).join('')
  } catch (e) {
    $('#journal').innerHTML = `<div class="hint err">journal error: ${e.message}</div>`
  }
}

function teamById (id) { return TEAMS.find(t => t.id === id) }
function flagFor (id) {
  const t = teamById(id)
  return t?.iso ? `<img class="inline-flag" src="${FLAG_CDN(t.iso)}" alt="${t.name} flag" />` : ''
}
function teamLabel (id) {
  const t = teamById(id)
  return t ? `${flagFor(id)} ${t.name}` : id
}
function matchLabelWithFlags (matchLabelRaw) {
  // matchLabelRaw is "home_id vs away_id" as strings; look up teams to
  // decorate with flags + proper names.
  const parts = String(matchLabelRaw || '').split(' vs ')
  if (parts.length !== 2) return matchLabelRaw
  return `${teamLabel(parts[0].trim())} <span class="vs-sep">vs</span> ${teamLabel(parts[1].trim())}`
}

function describeEvent (e) {
  switch (e.type) {
    case 'tip':
      return e.target === 'team'
        ? `<span class="highlight">${fmtUsdt(e.amount)}</span> → ${teamLabel(e.teamId)}`
        : `<span class="highlight">${fmtUsdt(e.amount)}</span> → ${e.playerName} (${teamLabel(e.teamId)})`
    case 'pool-created':
      return `pool <span class="highlight">"${e.purpose ?? '?'}"</span> ${e.teamId ? '· ' + teamLabel(e.teamId) : ''} · ${e.policy}`
    case 'pool-contribution':
      return `<span class="highlight">${fmtUsdt(e.amount)}</span> → pool ${e.poolId}`
    case 'pool-payout':
      return `payout <span class="highlight">${fmtUsdt(e.amount)}</span> → ${shortAddr(e.to)}`
    case 'pool-settled':
      return `${e.policy} settle · <span class="highlight">${fmtUsdt(e.totalUsdt)}</span> across ${e.payouts} recipients`
    case 'bet-placed': {
      // Resolve which team the outcome maps to (or Draw) and print it
      // directly. Repeating "on away · France vs Argentina" reads badly
      // when the reader has to reconstruct which is home and which is
      // away. Show the team the user actually backed.
      const [homeId, awayId] = String(e.matchLabel || '').split(' vs ').map(s => s.trim())
      let target
      if (e.outcome === 'draw') target = '<strong>Draw</strong>'
      else if (e.outcome === 'home') target = teamLabel(homeId)
      else target = teamLabel(awayId)
      return `<span class="highlight">${fmtUsdt(e.amount)}</span> on ${target}`
    }
    case 'bet-payout':
      return `payout <span class="highlight">${fmtUsdt(e.amount)}</span> → ${shortAddr(e.winner)}`
    case 'market-settled': {
      // Show the winner as a team lockup, not the raw "home/away/draw"
      // token, so the audit line reads at a glance.
      const [homeId, awayId] = String(e.matchLabel || '').split(' vs ').map(s => s.trim())
      let winner
      if (e.resultOutcome === 'draw') winner = '<strong>Draw</strong>'
      else if (e.resultOutcome === 'home') winner = teamLabel(homeId)
      else winner = teamLabel(awayId)
      const score = e.resultScore ? ` <span class="mono">${e.resultScore}</span>` : ''
      const payouts = typeof e.payouts === 'number' ? ` · ${e.payouts} payout${e.payouts === 1 ? '' : 's'}` : ''
      return `${winner} won${score}${payouts}`
    }
    default:
      return JSON.stringify(e).slice(0, 100)
  }
}

/* ─── Bootstrapping ─── */
async function loadTeams () {
  const { teams } = await api('/api/teams')
  TEAMS = teams
  const options = teams.map(t => ({ value: t.id, iso: t.iso, label: t.name, sub: t.nickname }))
  tipTeamDD = initDropdown($('[data-dropdown="tip-team"]'), options, () => {
    // Team change resets the player dropdown to the newly picked team's roster.
    if (TIP_MODE === 'player') refreshTipPlayerDD()
  }, { placeholder: 'Pick a team' })
  refreshTipPlayerDD()
  poolTeamDD = initDropdown($('[data-dropdown="pool-team"]'),
    [{ value: '', label: 'No team' }, ...options], () => {},
    { placeholder: 'No team', defaultValue: '' })
  poolPolicyDD = initDropdown($('[data-dropdown="pool-policy"]'), [
    // Human-readable labels + real-world examples so a fan understands
    // which one to pick without reading the docs.
    { value: 'equal', label: 'Refund everyone equally', sub: 'Same amount back to each contributor. Use for cancelled events.' },
    { value: 'proportional', label: 'Pay back share', sub: 'Everyone gets back their part of the pool. Use for savings clubs.' },
    { value: 'winner-takes', label: 'One winner takes all', sub: 'Whole pool to one address. Use for prizes or gifts.' },
  ], () => {}, { placeholder: 'Refund everyone equally', defaultValue: 'equal' })
}

async function loadMatches () {
  const { matches } = await api('/api/matches')
  MATCHES = matches
}

async function loadConfig () {
  CONFIG = await api('/api/config')
  // Point the "verify on the block explorer" link in the audit note at
  // whatever chain the server is configured for. Keeps the copy honest
  // if the operator flips CHAIN_ID on Vercel.
  const link = $('#explorer-link')
  if (link && CONFIG.explorer) link.href = CONFIG.explorer
}

// Wire buttons
$('#wallet-pill').addEventListener('click', openWalletModal)
$('#wallet-chip')?.addEventListener('click', openWalletModal)
$('#hero-connect').addEventListener('click', openWalletModal)

$('#reset-demo')?.addEventListener('click', async () => {
  // Clear both sides of the state: local optimistic cache AND the
  // server journal + settled-match overrides. On-chain USDt transfers
  // are still there; only the off-chain display is reset.
  //
  // We also stamp a reset timestamp in localStorage so every refresh
  // helper filters out any pre-reset event that a stale Lambda instance
  // might still return in /api/journal. Without this, the Vercel /tmp
  // split can silently repopulate the board a few seconds after reset.
  try {
    const now = Date.now()
    localStorage.setItem(RESET_AT_KEY, String(now))
    localStorage.removeItem(CLIENT_JOURNAL_KEY)
    localStorage.removeItem(HIDDEN_POOLS_KEY)
    await api('/api/dev/reset', { method: 'POST' })
    toast({ level: 'ok', title: 'Odds board reset', desc: 'Local cache + server journal cleared. On-chain txs remain permanent.' })
    await Promise.all([refreshStats(), refreshMarkets(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Reset failed', desc: e.message })
  }
})
$$('#wallet-modal [data-close]').forEach(el => el.addEventListener('click', closeWalletModal))
// Escape: the generic modal handles its own key (via stopPropagation).
// This fallback closes the wallet modal only when no generic modal is up.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (_genericModalOpen) return
  if (!$('#wallet-modal').hidden) closeWalletModal()
})

$('#tip-btn').addEventListener('click', submitTip)
$$('[data-tip-mode]').forEach(b => b.addEventListener('click', () => setTipMode(b.dataset.tipMode)))
$('#pool-create-btn').addEventListener('click', submitPool)

$('#modal-copy').addEventListener('click', () => CONNECTED && copyToClipboard(CONNECTED.address, 'Address copied'))
$('#modal-disconnect').addEventListener('click', () => { disconnect(); closeWalletModal() })

// Testnet-only faucet button on the connected wallet view. The demo
// MockUSDT contract has an unrestricted mint(), so any connected wallet
// can top itself up with 10 000 USDt in one signed tx. Removes the
// "your MetaMask has 0 USDt" onboarding cliff for judges and users.
$('#modal-mint')?.addEventListener('click', async () => {
  if (!CONNECTED) {
    return toast({ level: 'err', title: 'Connect a wallet first' })
  }
  if (!CONFIG?.usdt?.address) {
    return toast({ level: 'err', title: 'USDt contract not configured' })
  }
  const btn = $('#modal-mint')
  btn.disabled = true
  const originalLabel = btn.textContent
  try {
    let txHash
    if (CONNECTED.mode === 'external') {
      // Fan holds their own key: sign the mint from their browser wallet.
      btn.textContent = 'Sign in your wallet…'
      const MINT_ABI = ['function mint(address to, uint256 amount) external']
      const contract = new ethers.Contract(CONFIG.usdt.address, MINT_ABI, CONNECTED.signer)
      const amount = ethers.parseUnits('10000', CONFIG.usdt.decimals)
      const tx = await contract.mint(CONNECTED.address, amount)
      btn.textContent = 'Confirming…'
      const receipt = await tx.wait()
      if (receipt.status !== 1) throw new Error('Mint reverted on chain')
      txHash = tx.hash
    } else {
      // Demo mode: no browser signer available, ask the server to mint
      // via its WDK-owned wallet. Same on-chain effect, same audit trail.
      btn.textContent = 'Minting via server wallet…'
      const r = await api('/api/dev/mint', {
        method: 'POST',
        body: { to: CONNECTED.address, amount: 10000 },
      })
      txHash = r.hash
    }
    toast({ level: 'ok', title: 'Minted 10,000 USDt', txHash })
    await refreshConnectedBalances()
  } catch (e) {
    toast({ level: 'err', title: 'Mint failed', desc: e?.shortMessage || e?.message || 'Unknown error' })
  } finally {
    btn.disabled = false
    btn.textContent = originalLabel
  }
})
$$('.wallet-option[data-connect="injected"]').forEach(el => el.addEventListener('click', async () => {
  try { await connectInjected(); toast({ level: 'ok', title: 'Wallet connected', desc: shortAddr(CONNECTED.address) }) }
  catch (e) { toast({ level: 'err', title: 'Connection failed', desc: e.message }) }
}))
$$('.wallet-option[data-connect="demo"]').forEach(el => el.addEventListener('click', async () => {
  try { await connectDemo(); toast({ level: 'ok', title: 'Demo wallet active', desc: shortAddr(CONNECTED.address) }) }
  catch (e) { toast({ level: 'err', title: 'Demo wallet unavailable', desc: e.message }) }
}))

// Boot sequence. Wrapped so that a single failed endpoint does not brick
// the whole page. Every step is retried a few times with backoff, and
// visible errors go into a "server offline" banner rather than a scary
// alert(). Local dev servers often take a couple of seconds after nodemon
// restarts before /api/config responds.
async function bootWithRetry (fn, label, tries = 4) {
  let lastErr = null
  for (let i = 0; i < tries; i++) {
    try { return await fn() } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 400 * (i + 1))) }
  }
  console.warn(`[boot] ${label} still failing after ${tries} tries:`, lastErr?.message)
  throw lastErr
}

async function boot () {
  try {
    await bootWithRetry(loadConfig, 'loadConfig')
    await bootWithRetry(loadTeams, 'loadTeams')
    await bootWithRetry(loadMatches, 'loadMatches')
  } catch (e) {
    // Server offline: dim the operator status pills so judges can see it
    document.querySelectorAll('#operator-status, #operator-status-footer').forEach(el => {
      el.classList.remove('badge-live')
      el.classList.add('badge-offline')
      const label = el.querySelector('span:last-child')
      if (label) label.textContent = 'Operator offline'
    })
    toast({ level: 'err', title: 'Server offline', desc: 'Cannot reach the FanBank API. Start the local server (npm run dev) and refresh.' })
    return
  }
  // Config loaded successfully. Confirm the operator is live in the UI.
  document.querySelectorAll('#operator-status, #operator-status-footer').forEach(el => {
    el.classList.add('online')
  })
  await Promise.allSettled([refreshStats(), refreshMarkets(), refreshPools(), refreshJournal()])
  showConnectView()
  // Silently rehydrate the wallet if this browser was previously connected.
  // Fires after render so a slow MetaMask does not delay the initial paint.
  tryAutoReconnect().catch(() => {})
  setInterval(() => { if (CONNECTED) refreshConnectedBalances() }, 30_000)
  setInterval(refreshMarkets, 20_000)

  // Global chain-change listener. Previously the handler was only wired
  // inside connectInjected(), so switching chains while in demo mode (or
  // before ever connecting) produced no visible feedback. Registering
  // here means every wallet chain flip is announced regardless of mode,
  // and a wrong-chain warning fires proactively.
  if (window.ethereum?.on) {
    window.ethereum.on('chainChanged', async hexChainId => {
      const newChainId = parseInt(hexChainId, 16)
      const expected = CONFIG.chainId
      if (newChainId === expected) {
        toast({ level: 'ok', title: `Now on ${CONFIG.chainName || 'expected chain'}`, timeout: 3000 })
      } else {
        toast({ level: 'err', title: `Wrong network (chainId ${newChainId})`, desc: `FanBank runs on ${CONFIG.chainName || 'Base Sepolia'} (${expected}). Switch back to sign tx.`, timeout: 5000 })
      }
      if (CONNECTED?.provider) await refreshConnectedBalances().catch(() => {})
    })
  }
}

/// Backstop for any promise rejection that a handler forgot to catch.
/// Without this, an ethers.js network hiccup during a background poll
/// would surface as a red DevTools error only, and the user would see a
/// silently frozen counter. A short toast makes the failure visible and
/// hints at the recovery step.
window.addEventListener('unhandledrejection', ev => {
  const msg = friendlyError(ev.reason)
  console.warn('[fanbank] unhandled rejection:', ev.reason)
  toast({ level: 'err', title: 'Something went wrong', desc: msg, timeout: 4500 })
})
window.addEventListener('error', ev => {
  if (!ev.error) return
  console.warn('[fanbank] uncaught error:', ev.error)
})
boot()
