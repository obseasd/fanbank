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

/* ─── Toasts ─── */
function toast ({ level = 'ok', title, desc, txHash, timeout = 5500 } = {}) {
  const host = $('#toasts')
  const el = document.createElement('div')
  el.className = `toast ${level}`
  const icon = level === 'ok' ? '✓' : '!'
  const link = txHash
    ? ` · <a href="${CONFIG?.explorer || 'https://sepolia.etherscan.io'}/tx/${txHash}" target="_blank" rel="noopener">${shortHash(txHash)}</a>`
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
      // If chain not added yet, add it. Sepolia is well-known but some
      // wallets do not have it by default.
      if (e.code === 4902 || String(e.message || '').match(/unrecognized chain/i)) {
        await provider.send('wallet_addEthereumChain', [{
          chainId: '0x' + CONFIG.chainId.toString(16),
          chainName: 'Sepolia',
          nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [CONFIG.rpcHttp || 'https://ethereum-sepolia-rpc.publicnode.com'],
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
  eth.on?.('chainChanged', () => location.reload())
  showConnectedView()
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
  showConnectedView()
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

  if (!CONNECTED) {
    // Disconnected: show the big "Connect wallet" pill, hide the chip.
    pill.hidden = false
    if (chip) chip.hidden = true
    pill.classList.remove('ok', 'err')
    pill.querySelector('.label').textContent = 'Connect wallet'
    return
  }

  // Connected: swap the pill out for the compact chip. The chip stays
  // in the same slot on the right of the nav and opens the wallet modal
  // on click (wired at the bottom of this file).
  pill.hidden = true
  if (chip) {
    chip.hidden = false
    chip.querySelector('.addr').textContent = shortAddr(CONNECTED.address)
    chip.querySelector('.bal').textContent = fmtUsdt(CONNECTED.usdt)
  }

  $('#modal-address').textContent = CONNECTED.address
  $('#modal-usdt').textContent = fmtUsdt(CONNECTED.usdt)
  $('#modal-gas').textContent = fmtGas(CONNECTED.gas)
  $('#modal-explorer').href = `${CONFIG.explorer}/address/${CONNECTED.address}`
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
  showConnectView()
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

  _lastFocusedBeforeModal = document.activeElement
  root.hidden = false
  _genericModalOpen = true

  const revalidate = () => { submitBtn.disabled = !_validateFields(body, fields) }
  revalidate()
  body.addEventListener('input', revalidate)
  body.addEventListener('change', revalidate)

  // Focus first control (input/select) or fall back to the submit button
  // for confirm-only dialogs like payout preview.
  const firstControl = body.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') || submitBtn
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
        // Enter submits the form when valid.
        if (!submitBtn.disabled) {
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

let tipTeamDD, poolTeamDD, poolPolicyDD

/* ─── Tip flow ─── */
async function submitTip () {
  const teamId = tipTeamDD.getValue()
  const amount = Number($('#tip-amount').value)
  const hint = $('#tip-hint')
  if (!teamId) { hint.className = 'hint err'; hint.textContent = 'Pick a team first.'; return }
  if (!amount || amount <= 0) { hint.className = 'hint err'; hint.textContent = 'Amount must be positive.'; return }

  const btn = $('#tip-btn')
  btn.disabled = true
  hint.className = 'hint'
  hint.textContent = 'Waiting for wallet…'

  try {
    await ensureConnected()
    const team = TEAMS.find(t => t.id === teamId)
    let receipt
    if (CONNECTED.mode === 'external') {
      hint.textContent = 'Sign the USDt transfer in your wallet…'
      const res = await transferUsdt(team.tipAddress, amount)
      hint.textContent = `Tx sent, confirming…`
      receipt = res
      await api('/api/tip/team/external', { method: 'POST', body: {
        teamId, amount, txHash: res.hash, from: res.from, to: team.tipAddress,
      } })
    } else {
      const r = await api('/api/tip/team', { method: 'POST', body: { teamId, amount } })
      receipt = r.receipt
    }
    hint.className = 'hint ok'
    hint.textContent = `Tipped ${fmtUsdt(amount)} to ${team.name}. Tx ${shortHash(receipt.hash)}.`
    toast({ level: 'ok', title: `Tipped ${fmtUsdt(amount)} to ${team.name}`, txHash: receipt.hash })
    $('#tip-amount').value = ''
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshJournal()])
  } catch (e) {
    hint.className = 'hint err'
    hint.textContent = e.message
    toast({ level: 'err', title: 'Tip failed', desc: e.message })
  } finally {
    btn.disabled = false
  }
}

/* ─── Pool flow ─── */
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
  const values = await openModal({
    title: 'Contribute to pool',
    description: 'Signs a USDt transfer from your wallet into the pool escrow.',
    fields: [
      { name: 'amount', label: 'Amount', type: 'number', placeholder: '1.00', min: 0.01, step: 0.01, suffix: 'USDt', defaultValue: 1 },
    ],
    submit: 'Send contribution',
  })
  if (!values) return
  const amount = Number(values.amount)
  try {
    await ensureConnected()
    let receipt
    if (CONNECTED.mode === 'external') {
      receipt = await transferUsdt(CONFIG.escrow, amount)
      await api(`/api/pool/${poolId}/contribute/external`, { method: 'POST', body: {
        amount, txHash: receipt.hash, from: receipt.from, to: CONFIG.escrow,
      } })
    } else {
      const r = await api(`/api/pool/${poolId}/contribute`, { method: 'POST', body: { amount } })
      receipt = r.receipt
    }
    toast({ level: 'ok', title: `Contributed ${fmtUsdt(amount)}`, txHash: receipt.hash })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshPools(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Contribution failed', desc: e.message })
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
      { name: 'amount', label: 'Stake', type: 'number', placeholder: '1.00', min: 0.01, step: 0.01, suffix: 'USDt', defaultValue: 1 },
    ],
    submit: 'Place bet',
  })
  if (!values) return
  const amount = Number(values.amount)
  try {
    await ensureConnected()
    let receipt
    if (CONNECTED.mode === 'external') {
      receipt = await transferUsdt(CONFIG.escrow, amount)
      await api('/api/bet/external', { method: 'POST', body: {
        matchId, outcome, amount, txHash: receipt.hash, from: receipt.from, to: CONFIG.escrow,
      } })
    } else {
      const r = await api('/api/bet', { method: 'POST', body: { matchId, outcome, amount } })
      receipt = r.receipt
    }
    toast({ level: 'ok', title: `Bet placed: ${fmtUsdt(amount)} on ${outcomeLabel}`, txHash: receipt.hash })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshMarkets(), refreshJournal()])
  } catch (e) {
    toast({ level: 'err', title: 'Bet failed', desc: e.message })
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
        { value: 'home', label: `Home wins (${home?.name || match.home || 'home'})` },
        { value: 'draw', label: 'Draw' },
        { value: 'away', label: `Away wins (${away?.name || match.away || 'away'})` },
      ] },
      { name: 'score', label: 'Final score', type: 'text', placeholder: '2-1', required: false },
    ],
    submit: 'Settle market',
  })
  if (!values) return
  try {
    await api(`/api/match/${matchId}/settle-demo`, { method: 'POST', body: {
      outcome: values.outcome,
      score: values.score && values.score.trim() ? values.score.trim() : null,
    } })
    const r = await api(`/api/market/${matchId}/settle`, { method: 'POST' })
    toast({ level: 'ok', title: 'Market settled', desc: `${r.payouts} payouts, ${fmtUsdt(r.netPoolUsdt)} distributed` })
    await Promise.all([refreshConnectedBalances(), refreshStats(), refreshMarkets(), refreshJournal()])
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
          ? `<a class="journal-hash" href="${CONFIG?.explorer}/tx/${e.hash}" target="_blank" rel="noopener">${shortHash(e.hash)} ↗</a>`
          : '<span class="journal-hash">off-chain</span>'}
      </div>
    `).join('')
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
    case 'bet-placed':
      return `bet <span class="highlight">${fmtUsdt(e.amount)}</span> on <strong>${e.outcome}</strong> · ${matchLabelWithFlags(e.matchLabel)}`
    case 'bet-payout':
      return `payout <span class="highlight">${fmtUsdt(e.amount)}</span> → ${shortAddr(e.winner)}`
    case 'market-settled':
      return `${matchLabelWithFlags(e.matchLabel)} settled <strong>${e.resultOutcome}</strong> ${e.resultScore ?? ''} · ${e.payouts} payouts`
    default:
      return JSON.stringify(e).slice(0, 100)
  }
}

/* ─── Bootstrapping ─── */
async function loadTeams () {
  const { teams } = await api('/api/teams')
  TEAMS = teams
  const options = teams.map(t => ({ value: t.id, iso: t.iso, label: t.name, sub: t.nickname }))
  tipTeamDD = initDropdown($('[data-dropdown="tip-team"]'), options, () => {}, { placeholder: 'Pick a team' })
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
}

// Wire buttons
$('#wallet-pill').addEventListener('click', openWalletModal)
$('#wallet-chip')?.addEventListener('click', openWalletModal)
$('#hero-connect').addEventListener('click', openWalletModal)
$$('#wallet-modal [data-close]').forEach(el => el.addEventListener('click', closeWalletModal))
// Escape: the generic modal handles its own key (via stopPropagation).
// This fallback closes the wallet modal only when no generic modal is up.
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  if (_genericModalOpen) return
  if (!$('#wallet-modal').hidden) closeWalletModal()
})

$('#tip-btn').addEventListener('click', submitTip)
$('#pool-create-btn').addEventListener('click', submitPool)

$('#modal-copy').addEventListener('click', () => CONNECTED && copyToClipboard(CONNECTED.address, 'Address copied'))
$('#modal-disconnect').addEventListener('click', () => { disconnect(); closeWalletModal() })
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
  showConnectView()  // no wallet connected on boot
  setInterval(() => { if (CONNECTED) refreshConnectedBalances() }, 30_000)
  setInterval(refreshMarkets, 20_000)
}
boot()
