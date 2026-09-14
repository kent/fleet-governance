// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../../src/deploy/FleetDeployer.sol";
import {FleetRegistry} from "../../src/FleetRegistry.sol";
import {FleetVotes} from "../../src/FleetVotes.sol";
import {TaskLedger} from "../../src/TaskLedger.sol";
import {FleetHook} from "../../src/FleetHook.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

abstract contract FleetFixture is Test {
    uint256 internal constant N = 5;
    uint48 internal constant VOTING_DELAY = 15;
    uint32 internal constant VOTING_PERIOD = 120;
    uint256 internal constant TIMELOCK_DELAY = 30;
    uint64 internal constant MAX_LIFETIME = 7200;
    string internal constant CHARTER =
        '{"schema":"fleet.charter.v1","goal":"pass tests","allowedActionClasses":["read_repo","write_repo","run_tests"],"externalAllowlist":["registry.npmjs.org"]}';
    string internal constant DESC_SUFFIX = "\n#proposalTypeId=0";

    uint8 internal constant AGAINST = 0;
    uint8 internal constant FOR = 1;
    uint8 internal constant ABSTAIN = 2;

    address[] internal members;
    uint256[] internal memberKeys;
    address internal operator = makeAddr("operator");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal outsider = makeAddr("outsider");

    FleetRegistry internal registry;
    FleetVotes internal token;
    TimelockController internal timelock;
    TaskLedger internal ledger;
    FleetHook internal hook;
    AgoraGovernor internal governor;
    FleetAddresses internal addrs;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        FleetDeployParams memory p;
        p.tokenName = "Fleet Vote";
        p.tokenSymbol = "FLEET";
        p.members = new address[](N);
        p.agentManifests = new string[](N);
        string[5] memory roles = ["planner", "engineer", "critic", "budget", "safety"];
        for (uint256 i = 0; i < N; i++) {
            (address a, uint256 k) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            members.push(a);
            memberKeys.push(k);
            p.members[i] = a;
            p.agentManifests[i] = string.concat('{"role":"', roles[i], '"}');
        }
        p.fleetManifest = '{"experiment":"fixture"}';
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

        addrs = FleetDeployer.deploy(p);
        registry = FleetRegistry(addrs.registry);
        token = FleetVotes(addrs.token);
        timelock = TimelockController(payable(addrs.timelock));
        ledger = TaskLedger(addrs.ledger);
        hook = FleetHook(addrs.hook);
        governor = AgoraGovernor(payable(addrs.governor));
        vm.warp(block.timestamp + 1);
    }

    function openTask() internal returns (uint256 taskId) {
        vm.prank(operator);
        taskId = ledger.openTask(CHARTER, MAX_LIFETIME);
    }

    function actionCalldata(
        uint256 taskId,
        uint8 kind,
        uint32 version,
        bytes32 payloadHash,
        string memory newText,
        string memory summary
    ) internal pure returns (bytes memory) {
        return abi.encodeCall(TaskLedger.recordDecision, (taskId, kind, version, payloadHash, newText, summary));
    }

    function singleAction(bytes memory data)
        internal
        view
        returns (address[] memory t, uint256[] memory v, bytes[] memory c)
    {
        t = new address[](1);
        v = new uint256[](1);
        c = new bytes[](1);
        t[0] = address(ledger);
        c[0] = data;
    }

    function proposeDecision(uint256 agent, bytes memory data, string memory description)
        internal
        returns (uint256 pid, address[] memory t, uint256[] memory v, bytes[] memory c)
    {
        (t, v, c) = singleAction(data);
        vm.prank(members[agent]);
        pid = governor.propose(t, v, c, description);
    }

    function vote(uint256 agent, uint256 pid, uint8 support, string memory reason) internal {
        vm.prank(members[agent]);
        governor.castVoteWithReason(pid, support, reason);
    }

    function warpToActive(uint256 pid) internal {
        vm.warp(governor.proposalSnapshot(pid) + 1);
    }

    function warpPastDeadline(uint256 pid) internal {
        vm.warp(governor.proposalDeadline(pid) + 1);
    }

    function descHash(string memory description) internal pure returns (bytes32) {
        return keccak256(bytes(description));
    }

    function queueAs(address who, address[] memory t, uint256[] memory v, bytes[] memory c, string memory description) internal {
        vm.prank(who);
        governor.queue(t, v, c, descHash(description));
    }

    function executeAs(address who, address[] memory t, uint256[] memory v, bytes[] memory c, string memory description) internal {
        vm.prank(who);
        governor.execute(t, v, c, descHash(description));
    }

    function stateOf(uint256 pid) internal view returns (IGovernor.ProposalState) {
        return governor.state(pid);
    }

    /// @dev Mirrors AgoraGovernor._timelockSalt: bytes20(address(governor)) ^ descriptionHash.
    function timelockSalt(string memory description) internal view returns (bytes32) {
        return bytes20(address(governor)) ^ descHash(description);
    }
}
