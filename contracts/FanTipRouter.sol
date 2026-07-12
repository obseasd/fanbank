// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title FanTipRouter
/// @notice On-chain tip router for the FanBank fan economy.
///
/// A fan calls tipTeam(teamId, amount) or tipPlayer(teamId, playerName, amount).
/// The router pulls USDt from the fan via ERC20.transferFrom, forwards it to the
/// registered recipient address for that team or player, and emits a canonical
/// event that off-chain indexers pick up to render the audit journal.
///
/// The router itself never holds funds beyond a single tx frame, and takes 0 fee.
/// This matches the Rumble native creator tipping pattern cited by the Tether
/// Developers Cup WDK track brief.
contract FanTipRouter {
    IERC20 public immutable usdt;
    address public owner;

    /// @dev teamId ("france", "brazil", ...) => tip address for that team.
    mapping(string => address) public teamAddress;

    /// @dev keccak256(teamId, playerName) => tip address for that specific player.
    /// Keyed by hash to keep storage flat and avoid nested-mapping headaches.
    mapping(bytes32 => address) public playerAddress;

    event TeamRegistered(string indexed teamId, address indexed recipient);
    event PlayerRegistered(string indexed teamId, string playerName, address indexed recipient);
    event TeamTipped(address indexed fan, string teamId, address indexed recipient, uint256 amount);
    event PlayerTipped(address indexed fan, string teamId, string playerName, address indexed recipient, uint256 amount);
    event OwnerChanged(address indexed previous, address indexed next);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(address _usdt, address _owner) {
        usdt = IERC20(_usdt);
        owner = _owner;
        emit OwnerChanged(address(0), _owner);
    }

    // ─── Registry (operator seeds this at deploy time) ───

    function registerTeam(string calldata teamId, address recipient) external onlyOwner {
        require(recipient != address(0), "recipient zero");
        teamAddress[teamId] = recipient;
        emit TeamRegistered(teamId, recipient);
    }

    function registerPlayer(string calldata teamId, string calldata playerName, address recipient) external onlyOwner {
        require(recipient != address(0), "recipient zero");
        bytes32 key = keccak256(abi.encodePacked(teamId, "|", playerName));
        playerAddress[key] = recipient;
        emit PlayerRegistered(teamId, playerName, recipient);
    }

    // ─── Tipping ───

    function tipTeam(string calldata teamId, uint256 amount) external {
        require(amount > 0, "amount zero");
        address to = teamAddress[teamId];
        require(to != address(0), "team not registered");
        require(usdt.transferFrom(msg.sender, to, amount), "transferFrom failed");
        emit TeamTipped(msg.sender, teamId, to, amount);
    }

    function tipPlayer(string calldata teamId, string calldata playerName, uint256 amount) external {
        require(amount > 0, "amount zero");
        bytes32 key = keccak256(abi.encodePacked(teamId, "|", playerName));
        address to = playerAddress[key];
        require(to != address(0), "player not registered");
        require(usdt.transferFrom(msg.sender, to, amount), "transferFrom failed");
        emit PlayerTipped(msg.sender, teamId, playerName, to, amount);
    }

    // ─── Admin ───

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "owner zero");
        emit OwnerChanged(owner, next);
        owner = next;
    }
}
