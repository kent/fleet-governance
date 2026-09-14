// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {PlainVotes} from "./fixtures/PlainVotes.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/// @notice NOT FOR DEPLOYMENT. Negative demonstration: what FleetVotes's transfer and delegation
///         restrictions prevent.
/// @dev PlainVotes is a bare ERC20Votes: any address can be minted to and any address can delegate
///      to any other address. Five holders mint 1e18 each (mirroring the fleet's one-vote-per-member
///      supply), then four delegate to the fifth. That one address ends up holding all 5e18 of
///      voting power and can pass a proposal completely alone, with nobody else ever casting a
///      vote. FleetVotes forecloses the parts of this that are actually dangerous: there is no
///      public mint at all (supply is fixed once, in the constructor, to the registry's member
///      list), and delegation is restricted to other registered members, so voting power can only
///      ever move within the closed set of members the fleet actually consists of, never out to an
///      arbitrary outside address.
contract UnrestrictedDelegationTest is FleetFixture {
    function test_FifthHolderPassesAloneAfterFourDelegate() public {
        PlainVotes plain = new PlainVotes("Plain Vote", "PLAIN");
        address[5] memory holders;
        for (uint256 i = 0; i < 5; i++) {
            holders[i] = makeAddr(string.concat("plainHolder", vm.toString(i)));
            plain.mint(holders[i], 1e18);
        }

        vm.prank(holders[4]);
        plain.delegate(holders[4]);
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(holders[i]);
            plain.delegate(holders[4]);
        }
        vm.warp(block.timestamp + 1);

        // The bad outcome: one address now carries the entire fleet's worth of voting power.
        assertEq(plain.getVotes(holders[4]), 5e18);

        address bareGovernor = _deployBareGovernor(address(plain));
        vm.warp(block.timestamp + 1);

        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = address(plain);

        vm.prank(holders[4]);
        uint256 pid = AgoraGovernor(payable(bareGovernor)).propose(t, v, c, "solo pass");
        vm.warp(AgoraGovernor(payable(bareGovernor)).proposalSnapshot(pid) + 1);
        vm.prank(holders[4]);
        AgoraGovernor(payable(bareGovernor)).castVote(pid, FOR);
        vm.warp(AgoraGovernor(payable(bareGovernor)).proposalDeadline(pid) + 1);

        // The bad outcome: a single address passes a proposal with no other votes cast at all.
        assertEq(uint8(AgoraGovernor(payable(bareGovernor)).state(pid)), uint8(IGovernor.ProposalState.Succeeded));
    }

    /// @notice Real-contract contrast: the same concentration attempt against FleetVotes, where the
    ///         target of the delegation is not a registered member. FleetVotes rejects it outright.
    function test_RealFleetVotesRejectsDelegationToNonMember() public {
        vm.prank(members[0]);
        vm.expectRevert(abi.encodeWithSelector(FleetVotes.InvalidDelegatee.selector, outsider));
        token.delegate(outsider);
    }

    function _deployBareGovernor(address plainToken) internal returns (address governor) {
        bytes memory initCode = abi.encodePacked(
            type(AgoraGovernor).creationCode,
            abi.encode(
                VOTING_DELAY, VOTING_PERIOD, uint256(0), uint256(6000), plainToken, address(0), address(0), address(0), address(0)
            )
        );
        assembly ("memory-safe") {
            governor := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(governor != address(0), "governor deploy failed");
    }
}
