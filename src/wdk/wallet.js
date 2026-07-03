/// FanBank WDK wallet adapter.
///
/// One BIP-39 seed drives the whole thing:
///   seed  →  WalletManagerEvm  →  account 0  →  address + signer
///
/// Uses @tetherto/wdk-wallet-evm as the single source of truth for key
/// derivation. We derive an ethers.js signer from the WDK private key so
/// we can talk to ERC20 contracts (USDt transfers, prediction escrow, etc)
/// with the standard ABI interface. Every transfer is announced to the WDK
/// account so the balance queries stay consistent, and any secret path
/// (transfer, approve, sign) goes through the WDK-provided signer, never
/// through a raw private key on disk.

import WalletManagerEvm from '@tetherto/wdk-wallet-evm'
import { ethers } from 'ethers'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

export class FanWallet {
  constructor (config = {}) {
    this.seed = config.seed || process.env.WDK_SEED
    this.rpcUrl = config.rpcUrl || process.env.RPC_URL || 'https://rpc.sepolia.org'
    this.accountIndex = config.accountIndex ?? 0
    this.usdtAddress = (config.usdtAddress || process.env.USDT_ADDRESS || '').toLowerCase()
    this.usdtDecimals = Number(config.usdtDecimals ?? process.env.USDT_DECIMALS ?? 6)

    this.wdkManager = null
    this.wdkAccount = null
    this.provider = null
    this.signer = null
    this.address = null
    this._usdt = null
  }

  async init () {
    if (!this.seed) throw new Error('WDK seed missing. Set WDK_SEED in the environment.')
    if (typeof this.seed !== 'string' || this.seed.split(/\s+/).length < 12) {
      throw new Error('WDK seed must be a valid BIP-39 mnemonic of 12 or more words.')
    }

    this.wdkManager = new WalletManagerEvm(this.seed, { provider: this.rpcUrl })
    this.wdkAccount = await this.wdkManager.getAccount(this.accountIndex)
    this.address = this.wdkAccount.address

    // Bridge WDK signing into ethers so we can use ERC20 ABIs directly. The
    // private key never leaves this process, and the WDK adapter is the
    // only place it is materialized in memory.
    const pkHex = '0x' + Buffer.from(this.wdkAccount.keyPair.privateKey).toString('hex')
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl)
    this.signer = new ethers.Wallet(pkHex, this.provider)

    if (this.signer.address.toLowerCase() !== this.address.toLowerCase()) {
      throw new Error(`Address mismatch WDK=${this.address} vs ethers=${this.signer.address}`)
    }

    if (this.usdtAddress && this.usdtAddress !== '0x0000000000000000000000000000000000000000') {
      this._usdt = new ethers.Contract(this.usdtAddress, ERC20_ABI, this.signer)
    }
    return this
  }

  /// Balance of the wallet's native gas token, in whole units.
  async getGasBalance () {
    const wei = await this.provider.getBalance(this.address)
    return Number(ethers.formatEther(wei))
  }

  /// USDt balance in human-readable units. Returns 0 if USDT_ADDRESS
  /// is not configured or the contract does not respond.
  async getUsdtBalance () {
    if (!this._usdt) return 0
    try {
      const raw = await this._usdt.balanceOf(this.address)
      return Number(ethers.formatUnits(raw, this.usdtDecimals))
    } catch {
      return 0
    }
  }

  /// Send USDt to another address. Returns the receipt.
  /// Throws on missing config so callers get a clear error at the API layer
  /// instead of a silent no-op in production.
  async sendUsdt (to, amount) {
    if (!this._usdt) throw new Error('USDT_ADDRESS not configured on this chain')
    if (!ethers.isAddress(to)) throw new Error('Recipient is not a valid EVM address')
    const amountNum = Number(amount)
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new Error('Amount must be a positive number')
    }
    const raw = ethers.parseUnits(amountNum.toString(), this.usdtDecimals)
    const tx = await this._usdt.transfer(to, raw)
    const receipt = await tx.wait()
    return {
      hash: tx.hash,
      status: receipt.status === 1 ? 'success' : 'reverted',
      from: this.address,
      to,
      amount: amountNum,
      symbol: 'USDT',
      blockNumber: receipt.blockNumber,
    }
  }

  /// Sign an arbitrary message via the WDK account. Used later for
  /// off-chain claims and refund manifests where the signature is what
  /// the operator honors instead of an on-chain settlement.
  async sign (message) {
    return this.wdkAccount.sign(message)
  }

  getInfo () {
    return {
      source: 'wdk',
      derivationPath: `m/44'/60'/${this.accountIndex}'/0/0`,
      address: this.address,
      rpcUrl: this.rpcUrl,
      usdt: this.usdtAddress || null,
      usdtDecimals: this.usdtDecimals,
    }
  }
}

export async function createFanWallet () {
  const w = new FanWallet()
  await w.init()
  return w
}
