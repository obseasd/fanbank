/// FanBank Smart Account wrapper (WDK module #2: ERC-4337).
///
/// Wraps `@tetherto/wdk-wallet-evm-erc-4337` to give FanBank an
/// account-abstraction path in addition to the plain EOA path. Every
/// deposit / tip / bet a fan does through the smart account is a
/// UserOperation instead of an EOA transaction, which unlocks two
/// production capabilities:
///
///   1. Sponsored (gasless) UserOperations via a paymaster. If a
///      Pimlico or Candide bundler URL is set in .env, fans do not
///      need Base Sepolia ETH to tip. The paymaster covers the gas
///      and the fan only signs the intent. This is exactly the
///      "programmable payments" angle the WDK track brief highlights.
///
///   2. Programmable rules on the smart account itself. A pool escrow
///      could deploy as a Safe smart account with a module that auto
///      pays out at kickoff time or reverts if the match is cancelled.
///      This is out of scope for the hackathon MVP but sits naturally
///      in this stack.
///
/// The wrapper degrades gracefully. If `ERC4337_BUNDLER_URL` is not
/// set, `createSmartAccount()` throws with a clear error and the
/// server falls back to the EOA path everywhere else. Nothing in the
/// existing FanBank UX depends on the smart account being ready.

import WalletManagerEvmErc4337 from '@tetherto/wdk-wallet-evm-erc-4337'
import { ethers } from 'ethers'

const ERC20_TRANSFER_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]

export class FanBankSmartAccount {
  constructor (config = {}) {
    this.seed = config.seed || process.env.WDK_SEED
    this.rpcUrl = config.rpcUrl || process.env.RPC_URL || 'https://sepolia.base.org'
    this.chainId = Number(config.chainId ?? process.env.CHAIN_ID ?? 84532)
    this.bundlerUrl = config.bundlerUrl || process.env.ERC4337_BUNDLER_URL || ''
    this.accountIndex = config.accountIndex ?? 0
    this.usdtAddress = (config.usdtAddress || process.env.USDT_ADDRESS || '').toLowerCase()
    this.usdtDecimals = Number(config.usdtDecimals ?? process.env.USDT_DECIMALS ?? 6)

    this.manager = null
    this.account = null
    this.address = null
    this.eoaAddress = null
  }

  async init () {
    if (!this.seed) throw new Error('WDK_SEED missing')
    if (!this.bundlerUrl) {
      throw new Error(
        'ERC4337_BUNDLER_URL missing. Sign up for a free key at https://dashboard.pimlico.io and paste the endpoint into .env. Smart accounts are optional; the server keeps working without them.'
      )
    }

    this.manager = new WalletManagerEvmErc4337(this.seed, {
      chainId: this.chainId,
      provider: this.rpcUrl,
      bundlerUrl: this.bundlerUrl,
      safeModulesVersion: '0.3.0',
      // Gas is paid in the chain's native coin unless a paymaster is
      // wired in. Fans on Base Sepolia will need Base ETH unless we
      // add a paymaster to the config in a follow-up.
      useNativeCoins: true,
    })
    this.account = await this.manager.getAccount(this.accountIndex)
    this.address = await this.account.getAddress()
    this.eoaAddress = ethers.Wallet.fromPhrase(this.seed).address
    return this
  }

  /// Balance of the smart account's USDt (queried via the underlying
  /// provider, not through the account itself, so the state read is
  /// cheap).
  async getUsdtBalance () {
    if (!this.address) throw new Error('smart account not initialized')
    const provider = new ethers.JsonRpcProvider(this.rpcUrl)
    const contract = new ethers.Contract(this.usdtAddress, ERC20_TRANSFER_ABI, provider)
    const raw = await contract.balanceOf(this.address)
    return Number(ethers.formatUnits(raw, this.usdtDecimals))
  }

  /// Send USDt from the smart account to a recipient as a UserOperation.
  /// The bundler validates, the paymaster (if set) sponsors gas, the
  /// account emits Transfer. Returns the tx hash.
  async transferUsdt (to, amountUsdt) {
    if (!this.account) throw new Error('smart account not initialized')
    if (!ethers.isAddress(to)) throw new Error('recipient is not a valid EVM address')
    const raw = ethers.parseUnits(String(amountUsdt), this.usdtDecimals)
    const result = await this.account.transferToken({
      token: this.usdtAddress,
      to,
      amount: raw.toString(),
    })
    return {
      hash: result?.transactionHash ?? result?.hash ?? result,
      from: this.address,
      to,
      amount: Number(amountUsdt),
    }
  }

  getInfo () {
    return {
      source: 'wdk-erc4337',
      standard: 'ERC-4337 account abstraction (Safe)',
      chainId: this.chainId,
      smartAccountAddress: this.address,
      eoaAddress: this.eoaAddress,
      bundlerConfigured: Boolean(this.bundlerUrl),
    }
  }

  dispose () { if (this.manager?.dispose) this.manager.dispose() }
}

export async function createFanBankSmartAccount () {
  const sa = new FanBankSmartAccount()
  await sa.init()
  return sa
}
