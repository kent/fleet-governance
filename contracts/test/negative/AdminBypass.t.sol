// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

/// @notice NOT FOR DEPLOYMENT. Negative demonstration: what leaving admin and manager unset
///         prevents.
/// @dev AgoraGovernor.cancel allows the proposer, the admin, the manager, or the executor (the
///      timelock) to cancel a proposal. FleetDeployer._deployGovernor always passes
///      address(0), address(0) for admin and manager: nobody but the proposer themselves, or the
///      timelock after a successful vote, may ever cancel. If admin were instead set to some
///      account, that account could unilaterally cancel any member's proposal at any time, with no
///      vote, no charter basis, and no relationship to the proposal at all. This deploys a second
///      governor with admin = attacker to show exactly that.
contract AdminBypassTest is FleetFixture {
    address internal attacker = makeAddr("attacker");

    function test_AdminCancelsAnotherMembersProposal() public {
        address bareGovernor = _deployBareGovernor(attacker);

        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = address(ledger);
        string memory description = "member proposal";

        vm.prank(members[0]);
        uint256 pid = AgoraGovernor(payable(bareGovernor)).propose(t, v, c, description);

        vm.prank(attacker);
        AgoraGovernor(payable(bareGovernor)).cancel(t, v, c, keccak256(bytes(description)));

        // The bad outcome: an address with no stake in the proposal cancels it outright.
        assertEq(uint8(AgoraGovernor(payable(bareGovernor)).state(pid)), uint8(IGovernor.ProposalState.Canceled));
    }

    /// @notice Real-contract contrast: the same attacker against the pinned governor, where admin
    ///         and manager are both address(0). cancel() checks the sender before ever reaching a
    ///         hook and rejects anyone who is not the proposer, admin, manager, or timelock.
    function test_RealGovernorRejectsAttackerCancel() public {
        uint256 taskId = openTask();
        bytes memory data = actionCalldata(taskId, 0, 1, keccak256("p"), "", "s");
        string memory description = string.concat("real proposal", DESC_SUFFIX);
        (, address[] memory t, uint256[] memory v, bytes[] memory c) = proposeDecision(0, data, description);

        vm.prank(attacker);
        vm.expectRevert(AgoraGovernor.GovernorUnauthorizedCancel.selector);
        governor.cancel(t, v, c, descHash(description));
    }

    function _deployBareGovernor(address admin) internal returns (address governor) {
        bytes memory initCode = abi.encodePacked(
            type(AgoraGovernor).creationCode,
            abi.encode(VOTING_DELAY, VOTING_PERIOD, uint256(0), uint256(6000), address(token), address(0), admin, address(0), address(0))
        );
        assembly ("memory-safe") {
            governor := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(governor != address(0), "governor deploy failed");
    }
}
