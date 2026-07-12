// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/FanTipRouter.sol";
import "./shared/MockUSDT.sol";

contract FanTipRouterTest is Test {
    TestUSDT usdt;
    FanTipRouter router;
    address owner = address(0xA11CE);
    address fan = address(0xB0B);
    address franceRecipient = address(0xFAA);
    address mbappeRecipient = address(0xEE7);

    function setUp() public {
        usdt = new TestUSDT();
        router = new FanTipRouter(address(usdt), owner);
        usdt.mint(fan, 1_000_000_000); // 1000 USDt (6 decimals)
        vm.prank(fan);
        usdt.approve(address(router), type(uint256).max);
    }

    // ─── Registry ───

    function test_registerTeam_onlyOwner() public {
        vm.expectRevert("not owner");
        router.registerTeam("france", franceRecipient);

        vm.prank(owner);
        router.registerTeam("france", franceRecipient);
        assertEq(router.teamAddress("france"), franceRecipient);
    }

    function test_registerPlayer_storesByHash() public {
        vm.prank(owner);
        router.registerPlayer("france", "Mbappe", mbappeRecipient);
        bytes32 key = keccak256(abi.encodePacked("france", "|", "Mbappe"));
        assertEq(router.playerAddress(key), mbappeRecipient);
    }

    // ─── Tipping ───

    function test_tipTeam_movesFunds() public {
        vm.prank(owner);
        router.registerTeam("france", franceRecipient);

        vm.prank(fan);
        router.tipTeam("france", 10_000_000); // 10 USDt

        assertEq(usdt.balanceOf(franceRecipient), 10_000_000);
        assertEq(usdt.balanceOf(fan), 990_000_000);
        assertEq(usdt.balanceOf(address(router)), 0, "router keeps zero balance");
    }

    function test_tipTeam_revertsUnregistered() public {
        vm.prank(fan);
        vm.expectRevert("team not registered");
        router.tipTeam("brazil", 5_000_000);
    }

    function test_tipPlayer_movesFundsToPlayer() public {
        vm.prank(owner);
        router.registerPlayer("france", "Mbappe", mbappeRecipient);

        vm.prank(fan);
        router.tipPlayer("france", "Mbappe", 25_000_000); // 25 USDt

        assertEq(usdt.balanceOf(mbappeRecipient), 25_000_000);
    }

    function test_tip_emitsEvent() public {
        vm.prank(owner);
        router.registerTeam("france", franceRecipient);

        vm.expectEmit(true, false, true, true);
        emit FanTipRouter.TeamTipped(fan, "france", franceRecipient, 3_000_000);

        vm.prank(fan);
        router.tipTeam("france", 3_000_000);
    }

    function test_tip_revertsZero() public {
        vm.prank(owner);
        router.registerTeam("france", franceRecipient);
        vm.prank(fan);
        vm.expectRevert("amount zero");
        router.tipTeam("france", 0);
    }
}
