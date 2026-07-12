// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/ParimutuelMarket.sol";
import "./shared/MockUSDT.sol";

contract ParimutuelMarketTest is Test {
    TestUSDT usdt;
    ParimutuelMarket market;
    address oracle = address(0xFEED);
    address fee = address(0xFEE);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address charlie = address(0xC1);

    function setUp() public {
        usdt = new TestUSDT();
        market = new ParimutuelMarket(address(usdt), oracle, fee);
        address[3] memory who = [alice, bob, charlie];
        for (uint256 i; i < 3; ++i) {
            usdt.mint(who[i], 1_000_000_000);
            vm.prank(who[i]);
            usdt.approve(address(market), type(uint256).max);
        }
        vm.prank(oracle);
        market.openMarket("m_qf1");
    }

    // ─── Bet placement ───

    function test_placeBet_movesFundsAndUpdatesStakes() public {
        vm.prank(alice);
        market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 50_000_000);
        (, uint256 total, uint256 sh,,,, ) = market.markets("m_qf1");
        assertEq(total, 50_000_000);
        assertEq(sh, 50_000_000);
        assertEq(usdt.balanceOf(address(market)), 50_000_000);
    }

    function test_placeBet_revertsAfterSettle() public {
        vm.prank(alice); market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 10_000_000);
        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);

        vm.prank(bob);
        vm.expectRevert("market settled");
        market.placeBet("m_qf1", ParimutuelMarket.Outcome.Away, 5_000_000);
    }

    // ─── Settlement ───

    function test_settle_takesFeeAndEmits() public {
        vm.prank(alice); market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 100_000_000);
        vm.prank(bob); market.placeBet("m_qf1", ParimutuelMarket.Outcome.Away, 100_000_000);

        uint256 feeBefore = usdt.balanceOf(fee);
        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);
        // 2% of 200 USDt = 4 USDt
        assertEq(usdt.balanceOf(fee), feeBefore + 4_000_000);
    }

    // ─── Claim payout ───

    function test_claim_paysWinnerProRata() public {
        // Alice bets 100 home, Bob bets 100 away. Alice wins.
        vm.prank(alice); uint256 aBet = market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 100_000_000);
        vm.prank(bob); market.placeBet("m_qf1", ParimutuelMarket.Outcome.Away, 100_000_000);

        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);

        uint256 balBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        market.claimPayout(aBet);
        // Net pool = 200 - 4 (fee) = 196. Alice = 100% of winning side.
        assertEq(usdt.balanceOf(alice), balBefore + 196_000_000);
    }

    function test_claim_loserZero() public {
        vm.prank(alice); market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 100_000_000);
        vm.prank(bob); uint256 bBet = market.placeBet("m_qf1", ParimutuelMarket.Outcome.Away, 100_000_000);
        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);

        uint256 balBefore = usdt.balanceOf(bob);
        vm.prank(bob);
        market.claimPayout(bBet);
        assertEq(usdt.balanceOf(bob), balBefore); // no gain
    }

    function test_claim_revertsNotYourBet() public {
        vm.prank(alice); uint256 aBet = market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 10_000_000);
        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);

        vm.prank(bob);
        vm.expectRevert("not your bet");
        market.claimPayout(aBet);
    }

    function test_claim_doubleClaim() public {
        vm.prank(alice); uint256 aBet = market.placeBet("m_qf1", ParimutuelMarket.Outcome.Home, 10_000_000);
        vm.prank(oracle);
        market.settleMarket("m_qf1", ParimutuelMarket.Outcome.Home);
        vm.prank(alice);
        market.claimPayout(aBet);

        vm.prank(alice);
        vm.expectRevert("already claimed");
        market.claimPayout(aBet);
    }
}
