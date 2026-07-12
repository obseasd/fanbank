// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title ParimutuelMarket
/// @notice On-chain parimutuel prediction market for match outcomes.
///
/// Every stake is a real USDt transfer into the market escrow. Odds are not
/// declared by a bookmaker: they are the current stake distribution across the
/// three outcomes (home, away, draw). When the oracle settles the match the
/// winning side splits the entire pool pro-rata to their stake, minus a 2%
/// platform fee that is directly kept by the fee recipient.
///
/// No house edge beyond the 2%. No counterparty risk: winners are paid from
/// the losers' pooled stakes, which never left the contract.
///
/// The oracle is the deployer for the demo. Production would swap in a signed
/// oracle push or a multi-source confirmation contract.
contract ParimutuelMarket {
    enum Outcome { Home, Away, Draw }
    enum Status { Open, Settled }

    struct Market {
        string matchId;          // "m_qf3", "m_sf1", ...
        uint256 totalStake;
        uint256 stakeHome;
        uint256 stakeAway;
        uint256 stakeDraw;
        Outcome winning;
        Status status;
    }

    struct Bet {
        address bettor;
        string matchId;
        Outcome outcome;
        uint256 amount;
        bool claimed;
    }

    IERC20 public immutable usdt;
    address public oracle;
    address public feeRecipient;
    uint16 public constant PLATFORM_FEE_BPS = 200; // 2%

    mapping(string => Market) public markets;
    Bet[] public bets;
    /// @dev matchId => bet indices for that market, so a bettor can enumerate
    /// their entries efficiently off-chain.
    mapping(string => uint256[]) public betIdsByMatch;

    event MarketOpened(string indexed matchId);
    event BetPlaced(uint256 indexed betId, address indexed bettor, string matchId, Outcome outcome, uint256 amount);
    event MarketSettled(string indexed matchId, Outcome winning, uint256 totalStake, uint256 winningStake, uint256 feeUsdt);
    event PayoutClaimed(uint256 indexed betId, address indexed bettor, uint256 amount);

    modifier onlyOracle() { require(msg.sender == oracle, "not oracle"); _; }

    constructor(address _usdt, address _oracle, address _feeRecipient) {
        usdt = IERC20(_usdt);
        oracle = _oracle;
        feeRecipient = _feeRecipient;
    }

    // ─── Market lifecycle ───

    function openMarket(string calldata matchId) external onlyOracle {
        Market storage m = markets[matchId];
        require(bytes(m.matchId).length == 0, "already open");
        m.matchId = matchId;
        emit MarketOpened(matchId);
    }

    function placeBet(string calldata matchId, Outcome outcome, uint256 amount) external returns (uint256 betId) {
        Market storage m = markets[matchId];
        require(bytes(m.matchId).length != 0, "market not open");
        require(m.status == Status.Open, "market settled");
        require(amount > 0, "amount zero");

        require(usdt.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        m.totalStake += amount;
        if (outcome == Outcome.Home) m.stakeHome += amount;
        else if (outcome == Outcome.Away) m.stakeAway += amount;
        else m.stakeDraw += amount;

        bets.push(Bet({ bettor: msg.sender, matchId: matchId, outcome: outcome, amount: amount, claimed: false }));
        betId = bets.length - 1;
        betIdsByMatch[matchId].push(betId);
        emit BetPlaced(betId, msg.sender, matchId, outcome, amount);
    }

    /// @notice Oracle settles the match with the final outcome. Bets can then
    /// be claimed individually via claimPayout.
    function settleMarket(string calldata matchId, Outcome winning) external onlyOracle {
        Market storage m = markets[matchId];
        require(bytes(m.matchId).length != 0, "market not open");
        require(m.status == Status.Open, "already settled");
        m.winning = winning;
        m.status = Status.Settled;

        uint256 fee = (m.totalStake * PLATFORM_FEE_BPS) / 10000;
        uint256 winningStake = _stakeForOutcome(m, winning);
        if (fee > 0 && feeRecipient != address(0)) {
            require(usdt.transfer(feeRecipient, fee), "fee transfer failed");
        }
        emit MarketSettled(matchId, winning, m.totalStake, winningStake, fee);
    }

    // ─── Claim ───

    /// @notice A bettor claims their payout for a specific bet. Payout is
    /// (theirStake / winningSideTotalStake) * (totalStake - fee). Non-winners
    /// get zero and their bet is marked claimed so the state stays clean.
    function claimPayout(uint256 betId) external returns (uint256 payout) {
        Bet storage b = bets[betId];
        require(b.bettor == msg.sender, "not your bet");
        require(!b.claimed, "already claimed");

        Market storage m = markets[b.matchId];
        require(m.status == Status.Settled, "not settled");
        b.claimed = true;

        if (b.outcome != m.winning) {
            emit PayoutClaimed(betId, msg.sender, 0);
            return 0;
        }
        uint256 winningStake = _stakeForOutcome(m, m.winning);
        if (winningStake == 0) return 0;

        uint256 fee = (m.totalStake * PLATFORM_FEE_BPS) / 10000;
        uint256 netPool = m.totalStake - fee;
        payout = (b.amount * netPool) / winningStake;
        require(usdt.transfer(msg.sender, payout), "transfer failed");
        emit PayoutClaimed(betId, msg.sender, payout);
    }

    // ─── Views ───

    function betsCount() external view returns (uint256) { return bets.length; }
    function betCountForMatch(string calldata matchId) external view returns (uint256) {
        return betIdsByMatch[matchId].length;
    }

    function odds(string calldata matchId) external view returns (uint256 home, uint256 away, uint256 draw) {
        Market storage m = markets[matchId];
        home = m.stakeHome > 0 ? (m.totalStake * 1e6) / m.stakeHome : 0;
        away = m.stakeAway > 0 ? (m.totalStake * 1e6) / m.stakeAway : 0;
        draw = m.stakeDraw > 0 ? (m.totalStake * 1e6) / m.stakeDraw : 0;
    }

    function _stakeForOutcome(Market storage m, Outcome o) internal view returns (uint256) {
        if (o == Outcome.Home) return m.stakeHome;
        if (o == Outcome.Away) return m.stakeAway;
        return m.stakeDraw;
    }

    // ─── Admin ───

    function setOracle(address next) external onlyOracle { oracle = next; }
    function setFeeRecipient(address next) external onlyOracle { feeRecipient = next; }
}
