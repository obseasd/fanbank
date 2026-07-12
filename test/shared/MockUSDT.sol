// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Bare 6-decimal ERC20 with unrestricted mint. Only used by the test
/// suite to fund fans and check balances. The prod deploy uses the
/// canonical MockUSDT in contracts/ or a real USDt address.
contract TestUSDT {
    string public constant name = "Test USDT";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        emit Approval(msg.sender, s, a);
        return true;
    }
    function transfer(address to, uint256 a) external returns (bool) {
        _transfer(msg.sender, to, a);
        return true;
    }
    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 all = allowance[from][msg.sender];
        require(all >= a, "allowance");
        if (all != type(uint256).max) allowance[from][msg.sender] = all - a;
        _transfer(from, to, a);
        return true;
    }
    function _transfer(address from, address to, uint256 a) internal {
        require(balanceOf[from] >= a, "balance");
        unchecked { balanceOf[from] -= a; balanceOf[to] += a; }
        emit Transfer(from, to, a);
    }
}
