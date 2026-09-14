// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/// @notice NOT FOR DEPLOYMENT. Negative demonstration: what FleetHook's beforeVoteSucceeded rule
///         replaces.
/// @dev Deploys a second AgoraGovernor over the fixture's real FleetVotes token, with
///      hooks = address(0) instead of the pinned FleetHook. With no hook, AgoraGovernor falls back
///      to OpenZeppelin's stock GovernorCountingSimple: quorum is reached once
///      For + Against + Abstain meets the numerator's share of supply, and a vote succeeds whenever
///      For exceeds Against. On a 5-member, 5e18-supply token with a 6000 (60%) numerator, that lets
///      2 For (2e18) plus 1 Abstain (1e18) pass a proposal: participation of 3e18 clears the 3e18
///      quorum bar, and 2e18 For beats 0 Against, even though only two of five members ever voted
///      For and nobody voted Against. FleetHook.beforeVoteSucceeded replaces this default with a
///      For-only rule (For alone must reach quorum, and For must exceed Against), specifically so
///      Abstain votes cannot be used to pad participation toward a passing outcome.
contract ParticipationQuorumTest is FleetFixture {
    function test_TwoForOneAbstainSucceedsUnderDefaultCounting() public {
        address bareGovernor = _deployBareGovernor();

        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = address(ledger);

        vm.prank(members[0]);
        uint256 pid = AgoraGovernor(payable(bareGovernor)).propose(t, v, c, "quorum demo");
        vm.warp(AgoraGovernor(payable(bareGovernor)).proposalSnapshot(pid) + 1);

        vm.prank(members[0]);
        AgoraGovernor(payable(bareGovernor)).castVote(pid, FOR);
        vm.prank(members[1]);
        AgoraGovernor(payable(bareGovernor)).castVote(pid, FOR);
        vm.prank(members[2]);
        AgoraGovernor(payable(bareGovernor)).castVote(pid, ABSTAIN);

        vm.warp(AgoraGovernor(payable(bareGovernor)).proposalDeadline(pid) + 1);

        // The bad outcome: 2 For + 1 Abstain (no Against, two members silent) still succeeds.
        assertEq(uint8(AgoraGovernor(payable(bareGovernor)).state(pid)), uint8(IGovernor.ProposalState.Succeeded));
    }

    /// @notice Real-contract contrast: the identical vote tally, through the pinned governor and
    ///         FleetHook. For (2e18) never reaches quorum (3e18) on its own, so the hook reports the
    ///         vote as not succeeded and the proposal ends Defeated instead of Succeeded.
    function test_RealHookDefeatsSameTallyBecauseAbstainDoesNotCountTowardFor() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        string memory description = string.concat("quorum demo", DESC_SUFFIX);
        (uint256 pid,,,) = proposeDecision(0, data, description);
        warpToActive(pid);
        vote(0, pid, FOR, "for");
        vote(1, pid, FOR, "for");
        vote(2, pid, ABSTAIN, "abstain");
        warpPastDeadline(pid);
        assertEq(uint8(stateOf(pid)), uint8(IGovernor.ProposalState.Defeated));
    }

    function _deployBareGovernor() internal returns (address governor) {
        bytes memory initCode = abi.encodePacked(
            type(AgoraGovernor).creationCode,
            abi.encode(
                VOTING_DELAY, VOTING_PERIOD, uint256(0), uint256(6000), address(token), address(0), address(0), address(0), address(0)
            )
        );
        assembly ("memory-safe") {
            governor := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(governor != address(0), "governor deploy failed");
    }
}
