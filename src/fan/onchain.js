/// FanBank on-chain layer.
///
/// Thin ethers.js binding layer over the three FanBank primitive
/// contracts (FanTipRouter, FanPoolManager, ParimutuelMarket) plus
/// the USDt ERC-20. Everything the server needs to move USDt through
/// the on-chain primitives goes through this module, so a single seed
/// change (or a chain migration) does not fan out through five files.
///
/// The demo-mode path (server signs via WDK) uses these helpers with
/// the operator wallet's ethers signer. The external-mode path
/// (fan signs in their own browser wallet) re-implements the same calls
/// client side in public/app.js.

import { ethers } from 'ethers'

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]

const TIP_ROUTER_ABI = [
  'function tipTeam(string teamId, uint256 amount) external',
  'function tipPlayer(string teamId, string playerName, uint256 amount) external',
  'function teamAddress(string) view returns (address)',
  'function playerAddress(bytes32) view returns (address)',
  'function registerTeam(string teamId, address recipient) external',
  'function registerPlayer(string teamId, string playerName, address recipient) external',
  'event TeamTipped(address indexed fan, string teamId, address indexed recipient, uint256 amount)',
  'event PlayerTipped(address indexed fan, string teamId, string playerName, address indexed recipient, uint256 amount)',
]

const POOL_MANAGER_ABI = [
  'function createPool(string purpose, uint8 policy, string teamId, uint256 payoutTime) returns (uint256 poolId)',
  'function contribute(uint256 poolId, uint256 amount) external',
  'function payoutEqual(uint256 poolId, address[] recipients) external',
  'function payoutProportional(uint256 poolId, address[] contributors) external',
  'function payoutWinnerTakes(uint256 poolId, address winner) external',
  'function pools(uint256) view returns (address creator, string purpose, uint8 policy, string teamId, uint256 totalUsdt, uint256 payoutTime, bool settled)',
  'function contributionOf(uint256, address) view returns (uint256)',
  'function nextPoolId() view returns (uint256)',
  'event PoolCreated(uint256 indexed poolId, address indexed creator, string purpose, uint8 policy, string teamId, uint256 payoutTime)',
  'event Contributed(uint256 indexed poolId, address indexed fan, uint256 amount, uint256 newTotal)',
  'event Settled(uint256 indexed poolId, uint256 totalDistributed)',
  'event PaidOut(uint256 indexed poolId, address indexed to, uint256 amount)',
]

const MARKET_ABI = [
  'function openMarket(string matchId) external',
  'function placeBet(string matchId, uint8 outcome, uint256 amount) returns (uint256 betId)',
  'function settleMarket(string matchId, uint8 winning) external',
  'function claimPayout(uint256 betId) returns (uint256 payout)',
  'function markets(string) view returns (string matchId, uint256 totalStake, uint256 stakeHome, uint256 stakeAway, uint256 stakeDraw, uint8 winning, uint8 status)',
  'function odds(string) view returns (uint256 home, uint256 away, uint256 draw)',
  'function betsCount() view returns (uint256)',
  'function bets(uint256) view returns (address bettor, string matchId, uint8 outcome, uint256 amount, bool claimed)',
  'event MarketOpened(string indexed matchId)',
  'event BetPlaced(uint256 indexed betId, address indexed bettor, string matchId, uint8 outcome, uint256 amount)',
  'event MarketSettled(string indexed matchId, uint8 winning, uint256 totalStake, uint256 winningStake, uint256 feeUsdt)',
  'event PayoutClaimed(uint256 indexed betId, address indexed bettor, uint256 amount)',
]

/// Bind the three contracts to an ethers signer (or provider for
/// read-only). Reads addresses from process.env so a chain flip needs
/// nothing more than an .env edit.
export function bindOnChain (signerOrProvider) {
  const usdt = process.env.USDT_ADDRESS
  const tipRouter = process.env.FANTIP_ROUTER_ADDRESS
  const poolManager = process.env.FANPOOL_MANAGER_ADDRESS
  const market = process.env.PARIMUTUEL_MARKET_ADDRESS
  if (!usdt || !tipRouter || !poolManager || !market) {
    throw new Error('Missing on-chain addresses in .env (USDT_ADDRESS, FANTIP_ROUTER_ADDRESS, FANPOOL_MANAGER_ADDRESS, PARIMUTUEL_MARKET_ADDRESS)')
  }
  return {
    usdt: new ethers.Contract(usdt, ERC20_ABI, signerOrProvider),
    tipRouter: new ethers.Contract(tipRouter, TIP_ROUTER_ABI, signerOrProvider),
    poolManager: new ethers.Contract(poolManager, POOL_MANAGER_ABI, signerOrProvider),
    market: new ethers.Contract(market, MARKET_ABI, signerOrProvider),
  }
}

/// Ensure the caller has approved a spender for at least `amountUsdt`.
/// Idempotent: if the current allowance already covers the amount we
/// skip the approve() tx. Returns the allowance-set tx hash when a new
/// approval had to be sent, or null when the existing allowance was
/// enough.
export async function ensureAllowance ({ usdt, owner, spender, amountRaw }) {
  const current = await usdt.allowance(owner, spender)
  if (current >= amountRaw) return null
  const tx = await usdt.approve(spender, ethers.MaxUint256)
  const receipt = await tx.wait()
  return { hash: tx.hash, blockNumber: receipt.blockNumber }
}

// ─── Policy enum mirrors FanPoolManager.Policy ───
export const POLICY = { Equal: 0, Proportional: 1, WinnerTakes: 2 }
export const OUTCOME = { Home: 0, Away: 1, Draw: 2 }
export const POLICY_LABEL = { 0: 'equal', 1: 'proportional', 2: 'winner-takes' }
export const OUTCOME_LABEL = { 0: 'home', 1: 'away', 2: 'draw' }
