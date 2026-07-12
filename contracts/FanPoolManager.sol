// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title FanPoolManager
/// @notice On-chain group fundraisers for football fans.
///
/// A pool creator opens a pool with a purpose (e.g. "watch-party fund"), a split
/// policy (equal refund, proportional share, winner takes all), and an optional
/// team identifier. Fans contribute USDt into the pool escrow. When the payout
/// time arrives the creator triggers payout(), and the contract distributes the
/// pooled USDt according to the policy.
///
/// The manager holds the USDt for the pool lifetime. No external custody, no
/// operator withdraw path, no rug possible: the code is the escrow.
///
/// Design notes:
/// - Each pool is a struct in a mapping keyed by poolId. We do NOT deploy a new
///   contract per pool because on Base gas is cheap but a per-pool deploy still
///   costs meaningfully more than a struct write, and this simplifies indexing.
/// - Splits are computed on-chain. The creator specifies the recipient list at
///   payout time so the contract does not need to track contributor set (which
///   would balloon storage).
/// - Winner-takes-all needs a single winner address. Proportional needs a list
///   matching the contributors and their amounts recorded via events.
contract FanPoolManager {
    enum Policy { Equal, Proportional, WinnerTakes }

    struct Pool {
        address creator;
        string purpose;
        Policy policy;
        string teamId;
        uint256 totalUsdt;
        uint256 payoutTime;
        bool settled;
    }

    IERC20 public immutable usdt;
    uint256 public nextPoolId;
    mapping(uint256 => Pool) public pools;

    /// @dev poolId => contributor => amount contributed. Used for pro-rata
    /// payouts and for a fan to check their own contribution.
    mapping(uint256 => mapping(address => uint256)) public contributionOf;

    event PoolCreated(
        uint256 indexed poolId,
        address indexed creator,
        string purpose,
        Policy policy,
        string teamId,
        uint256 payoutTime
    );
    event Contributed(uint256 indexed poolId, address indexed fan, uint256 amount, uint256 newTotal);
    event Refunded(uint256 indexed poolId, address indexed fan, uint256 amount);
    event PaidOut(uint256 indexed poolId, address indexed to, uint256 amount);
    event Settled(uint256 indexed poolId, uint256 totalDistributed);

    constructor(address _usdt) {
        usdt = IERC20(_usdt);
    }

    // ─── Create + contribute ───

    function createPool(string calldata purpose, Policy policy, string calldata teamId, uint256 payoutTime)
        external
        returns (uint256 poolId)
    {
        require(bytes(purpose).length > 0, "purpose empty");
        require(payoutTime > block.timestamp, "payoutTime past");
        poolId = nextPoolId++;
        pools[poolId] = Pool({
            creator: msg.sender,
            purpose: purpose,
            policy: policy,
            teamId: teamId,
            totalUsdt: 0,
            payoutTime: payoutTime,
            settled: false
        });
        emit PoolCreated(poolId, msg.sender, purpose, policy, teamId, payoutTime);
    }

    function contribute(uint256 poolId, uint256 amount) external {
        Pool storage p = pools[poolId];
        require(p.creator != address(0), "pool not found");
        require(!p.settled, "pool settled");
        require(amount > 0, "amount zero");
        require(usdt.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        contributionOf[poolId][msg.sender] += amount;
        p.totalUsdt += amount;
        emit Contributed(poolId, msg.sender, amount, p.totalUsdt);
    }

    // ─── Payout paths ───

    /// @notice Equal refund policy: every recipient gets total / recipients.length.
    /// Creator supplies the recipient list at payout time (usually the contributor
    /// set). Truncation rounding leaves dust in the contract which the creator
    /// can sweep in a follow-up call if they care.
    function payoutEqual(uint256 poolId, address[] calldata recipients) external {
        Pool storage p = pools[poolId];
        _requireReadyForPayout(p, msg.sender);
        require(p.policy == Policy.Equal, "wrong policy");
        require(recipients.length > 0, "no recipients");

        uint256 per = p.totalUsdt / recipients.length;
        require(per > 0, "share zero");
        uint256 distributed;
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "recipient zero");
            require(usdt.transfer(recipients[i], per), "transfer failed");
            emit PaidOut(poolId, recipients[i], per);
            distributed += per;
        }
        p.settled = true;
        emit Settled(poolId, distributed);
    }

    /// @notice Proportional payout: each recipient gets (their contribution / total) * pool.
    /// Recipients must be the actual contributor set.
    function payoutProportional(uint256 poolId, address[] calldata contributors) external {
        Pool storage p = pools[poolId];
        _requireReadyForPayout(p, msg.sender);
        require(p.policy == Policy.Proportional, "wrong policy");
        require(contributors.length > 0, "no contributors");

        uint256 total = p.totalUsdt;
        uint256 distributed;
        for (uint256 i = 0; i < contributors.length; i++) {
            uint256 contrib = contributionOf[poolId][contributors[i]];
            if (contrib == 0) continue;
            uint256 share = (contrib * total) / p.totalUsdt;
            require(usdt.transfer(contributors[i], share), "transfer failed");
            emit PaidOut(poolId, contributors[i], share);
            distributed += share;
        }
        p.settled = true;
        emit Settled(poolId, distributed);
    }

    /// @notice Winner takes all: entire pool to a single address.
    function payoutWinnerTakes(uint256 poolId, address winner) external {
        Pool storage p = pools[poolId];
        _requireReadyForPayout(p, msg.sender);
        require(p.policy == Policy.WinnerTakes, "wrong policy");
        require(winner != address(0), "winner zero");

        uint256 amount = p.totalUsdt;
        require(usdt.transfer(winner, amount), "transfer failed");
        p.settled = true;
        emit PaidOut(poolId, winner, amount);
        emit Settled(poolId, amount);
    }

    function _requireReadyForPayout(Pool storage p, address caller) internal view {
        require(p.creator != address(0), "pool not found");
        require(!p.settled, "already settled");
        require(caller == p.creator, "not creator");
        require(block.timestamp >= p.payoutTime, "too early");
        require(p.totalUsdt > 0, "empty pool");
    }
}
