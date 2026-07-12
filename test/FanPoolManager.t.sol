// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/FanPoolManager.sol";
import "./shared/MockUSDT.sol";

contract FanPoolManagerTest is Test {
    TestUSDT usdt;
    FanPoolManager mgr;
    address alice = address(0xA1);
    address bob = address(0xB0);
    address charlie = address(0xC1);
    address dave = address(0xD1);

    function setUp() public {
        usdt = new TestUSDT();
        mgr = new FanPoolManager(address(usdt));

        for (uint256 i; i < 4; ++i) {
            address[4] memory who = [alice, bob, charlie, dave];
            usdt.mint(who[i], 1_000_000_000);
            vm.prank(who[i]);
            usdt.approve(address(mgr), type(uint256).max);
        }
    }

    function _openEqualPool() internal returns (uint256 id) {
        vm.prank(alice);
        id = mgr.createPool("watch party", FanPoolManager.Policy.Equal, "france", block.timestamp + 1 days);
    }

    // ─── Create ───

    function test_createPool_seedsFields() public {
        uint256 id = _openEqualPool();
        (address creator, string memory purpose, FanPoolManager.Policy policy,,, uint256 payoutTime, bool settled) =
            mgr.pools(id);
        assertEq(creator, alice);
        assertEq(purpose, "watch party");
        assertEq(uint8(policy), uint8(FanPoolManager.Policy.Equal));
        assertEq(payoutTime, block.timestamp + 1 days);
        assertFalse(settled);
    }

    function test_createPool_revertsPastPayoutTime() public {
        vm.prank(alice);
        vm.expectRevert("payoutTime past");
        mgr.createPool("bad", FanPoolManager.Policy.Equal, "brazil", block.timestamp - 1);
    }

    // ─── Contribute ───

    function test_contribute_incrementsTotal() public {
        uint256 id = _openEqualPool();
        vm.prank(bob);
        mgr.contribute(id, 100_000_000);
        vm.prank(charlie);
        mgr.contribute(id, 200_000_000);

        (,,,, uint256 total,,) = mgr.pools(id);
        assertEq(total, 300_000_000);
        assertEq(mgr.contributionOf(id, bob), 100_000_000);
        assertEq(mgr.contributionOf(id, charlie), 200_000_000);
    }

    // ─── Equal payout ───

    function test_payoutEqual_splitsExactly() public {
        uint256 id = _openEqualPool();
        vm.prank(bob); mgr.contribute(id, 60_000_000);
        vm.prank(charlie); mgr.contribute(id, 60_000_000);
        vm.prank(dave); mgr.contribute(id, 60_000_000);
        vm.warp(block.timestamp + 2 days);

        address[] memory rcpts = new address[](3);
        rcpts[0] = bob; rcpts[1] = charlie; rcpts[2] = dave;

        uint256 balBefore = usdt.balanceOf(bob);
        vm.prank(alice);
        mgr.payoutEqual(id, rcpts);
        assertEq(usdt.balanceOf(bob), balBefore + 60_000_000);
    }

    function test_payoutEqual_revertsNotCreator() public {
        uint256 id = _openEqualPool();
        vm.prank(bob); mgr.contribute(id, 60_000_000);
        vm.warp(block.timestamp + 2 days);

        address[] memory rcpts = new address[](1);
        rcpts[0] = bob;
        vm.prank(bob);
        vm.expectRevert("not creator");
        mgr.payoutEqual(id, rcpts);
    }

    // ─── Proportional payout ───

    function test_payoutProportional_respectsShares() public {
        vm.prank(alice);
        uint256 id = mgr.createPool("split", FanPoolManager.Policy.Proportional, "france", block.timestamp + 1 hours);

        vm.prank(bob); mgr.contribute(id, 100_000_000);   // 100 USDt (1/6)
        vm.prank(charlie); mgr.contribute(id, 200_000_000); // 200 USDt (2/6)
        vm.prank(dave); mgr.contribute(id, 300_000_000);   // 300 USDt (3/6)
        vm.warp(block.timestamp + 2 hours);

        address[] memory contribs = new address[](3);
        contribs[0] = bob; contribs[1] = charlie; contribs[2] = dave;

        uint256 bobBefore = usdt.balanceOf(bob);
        uint256 charlieBefore = usdt.balanceOf(charlie);
        uint256 daveBefore = usdt.balanceOf(dave);

        vm.prank(alice);
        mgr.payoutProportional(id, contribs);

        assertEq(usdt.balanceOf(bob), bobBefore + 100_000_000);
        assertEq(usdt.balanceOf(charlie), charlieBefore + 200_000_000);
        assertEq(usdt.balanceOf(dave), daveBefore + 300_000_000);
    }

    // ─── Winner takes all ───

    function test_payoutWinnerTakes_sendsFullPot() public {
        vm.prank(alice);
        uint256 id = mgr.createPool("wta", FanPoolManager.Policy.WinnerTakes, "brazil", block.timestamp + 1 hours);
        vm.prank(bob); mgr.contribute(id, 100_000_000);
        vm.prank(charlie); mgr.contribute(id, 50_000_000);
        vm.warp(block.timestamp + 2 hours);

        uint256 daveBefore = usdt.balanceOf(dave);
        vm.prank(alice);
        mgr.payoutWinnerTakes(id, dave);
        assertEq(usdt.balanceOf(dave), daveBefore + 150_000_000);

        (,,,,,, bool settled) = mgr.pools(id);
        assertTrue(settled);
    }
}
