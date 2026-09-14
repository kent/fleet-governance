// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetFixture} from "../fixtures/FleetFixture.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../../src/deploy/FleetDeployer.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract BallotProfilesTest is FleetFixture {
    /// Digit per member: 0 = no vote, 1 = Against, 2 = For, 3 = Abstain. 4^5 = 1024 profiles.
    function test_AllBallotProfilesMatchForOnlyRule() public {
        for (uint256 profile = 0; profile < 1024; profile++) {
            uint256 taskId = openTask();
            bytes memory data = actionCalldata(taskId, 0, 1, keccak256(abi.encode(profile)), "", "profile");
            string memory description = string.concat("profile ", vm.toString(profile), DESC_SUFFIX);
            (uint256 pid,,,) = proposeDecision(0, data, description);
            warpToActive(pid);
            uint256 forCount;
            uint256 againstCount;
            uint256 digits = profile;
            for (uint256 i = 0; i < N; i++) {
                uint256 d = digits % 4;
                digits /= 4;
                if (d == 1) {
                    vote(i, pid, AGAINST, "against");
                    againstCount++;
                } else if (d == 2) {
                    vote(i, pid, FOR, "for");
                    forCount++;
                } else if (d == 3) {
                    vote(i, pid, ABSTAIN, "abstain");
                }
            }
            warpPastDeadline(pid);
            bool expected = forCount >= 3 && forCount > againstCount;
            IGovernor.ProposalState want =
                expected ? IGovernor.ProposalState.Succeeded : IGovernor.ProposalState.Defeated;
            assertEq(uint8(stateOf(pid)), uint8(want), string.concat("profile ", vm.toString(profile)));
        }
    }

    function test_EffectiveYesCountForOtherFleetSizes() public {
        // Each call goes through `this.` so it runs in its own EVM call frame: HookMiner.find's
        // per-iteration abi.encodePacked bump-allocates memory that a call frame never frees, and
        // three sequential internal calls would accumulate that memory until the third mining round
        // exceeds Foundry's EVM memory limit (observed: EvmError: MemoryOOG on the n=10 case when
        // the three calls shared one frame; see docs/compatibility-notes.md).
        this._checkFleet(3, 2); // ceil(0.6*3)  = 2
        this._checkFleet(7, 5); // ceil(0.6*7)  = 5 (4.2 -> 5)
        this._checkFleet(10, 6); // ceil(0.6*10) = 6
    }

    function _checkFleet(uint256 n, uint256 expectedYes) external {
        FleetDeployParams memory p;
        p.tokenName = "T";
        p.tokenSymbol = "T";
        p.members = new address[](n);
        p.agentManifests = new string[](n);
        for (uint256 i = 0; i < n; i++) {
            p.members[i] = makeAddr(string.concat("n", vm.toString(n), "-", vm.toString(i)));
            p.agentManifests[i] = "{}";
        }
        p.fleetManifest = "{}";
        p.operator = operator;
        p.guardian = guardian;
        p.votingDelay = VOTING_DELAY;
        p.votingPeriod = VOTING_PERIOD;
        p.proposalThreshold = 1e18;
        p.quorumNumerator = 6000;
        p.timelockDelay = TIMELOCK_DELAY;
        p.maxTaskLifetime = MAX_LIFETIME;
        p.create2Deployer = address(this);
        p.deployer = address(this);
        FleetAddresses memory a = FleetDeployer.deploy(p);
        AgoraGovernor gov = AgoraGovernor(payable(a.governor));
        TaskLedger led = TaskLedger(a.ledger);
        vm.warp(block.timestamp + 1);
        vm.prank(operator);
        uint256 taskId = led.openTask(CHARTER, MAX_LIFETIME);
        address[] memory t = new address[](1);
        uint256[] memory v = new uint256[](1);
        bytes[] memory c = new bytes[](1);
        t[0] = a.ledger;
        c[0] = abi.encodeCall(TaskLedger.recordDecision, (taskId, 0, 1, keccak256("p"), "", "s"));

        // expectedYes - 1 For votes: defeated
        vm.prank(p.members[0]);
        uint256 pid1 = gov.propose(t, v, c, string.concat("under", DESC_SUFFIX));
        vm.warp(gov.proposalSnapshot(pid1) + 1);
        for (uint256 i = 0; i < expectedYes - 1; i++) {
            vm.prank(p.members[i]);
            gov.castVoteWithReason(pid1, 1, "for");
        }
        vm.warp(gov.proposalDeadline(pid1) + 1);
        assertEq(uint8(gov.state(pid1)), uint8(IGovernor.ProposalState.Defeated), "under threshold");

        // expectedYes For votes: succeeded (different proposer to avoid the unsettled-slot rule)
        vm.prank(p.members[1]);
        uint256 pid2 = gov.propose(t, v, c, string.concat("at", DESC_SUFFIX));
        vm.warp(gov.proposalSnapshot(pid2) + 1);
        for (uint256 i = 0; i < expectedYes; i++) {
            vm.prank(p.members[i]);
            gov.castVoteWithReason(pid2, 1, "for");
        }
        vm.warp(gov.proposalDeadline(pid2) + 1);
        assertEq(uint8(gov.state(pid2)), uint8(IGovernor.ProposalState.Succeeded), "at threshold");
    }
}
