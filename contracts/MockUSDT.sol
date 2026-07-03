// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MockUSDT
/// @notice Minimal ERC20 with an unrestricted mint() for the FanBank
/// testnet demo. Everyone can mint themselves USDT, so judges and users
/// can walk through the tipping / pool / prediction flow without waiting
/// on a faucet.
///
/// Production would obviously use the real Tether USDT contract on the
/// deployed chain (USDT on Base mainnet, USDT on BSC, etc). This is a
/// testnet stand-in with the exact same 6-decimal ERC20 interface so the
/// FanBank code is chain-agnostic.
contract MockUSDT {
    string public constant name = "USDT (FanBank testnet mock)";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// @notice Unrestricted mint for testnet demo purposes.
    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "ERC20: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "ERC20: to zero");
        uint256 bal = balanceOf[from];
        require(bal >= amount, "ERC20: balance");
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }
}
