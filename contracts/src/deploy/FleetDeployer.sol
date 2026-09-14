// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {FleetRegistry} from "../FleetRegistry.sol";
import {FleetVotes} from "../FleetVotes.sol";
import {TaskLedger} from "../TaskLedger.sol";
import {FleetHook} from "../FleetHook.sol";
import {HookMiner} from "./HookMiner.sol";

struct FleetDeployParams {
    string tokenName;
    string tokenSymbol;
    address[] members;
    string[] agentManifests;
    string fleetManifest;
    address operator;
    address guardian;
    uint48 votingDelay;
    uint32 votingPeriod;
    uint256 proposalThreshold;
    uint256 quorumNumerator;
    uint256 timelockDelay;
    uint64 maxTaskLifetime;
    address create2Deployer;
    address deployer;
}

struct FleetAddresses {
    address registry;
    address token;
    address timelock;
    address ledger;
    address hook;
    address governor;
    bytes32 hookSalt;
}

/// @notice The deployment sequence of spec section 7.1, shared by the Foundry script and the test fixture.
/// @dev Runs in the caller's context. In tests the caller is the test contract (CREATE2 from it);
///      under `vm.broadcast` Foundry routes CREATE2 through the canonical deployer, so `create2Deployer`
///      must be `0x4e59b44847b379578588920cA78FbF26c0B4956C` there.
library FleetDeployer {
    error HookAddressMismatch(address predicted, address actual);
    error GovernorDeploymentFailed();

    /// @notice Must equal FleetHook.PERMISSION_MASK (0x22C0). Duplicated here because a contract's
    ///         public constant is not addressable as ContractName.CONSTANT from another file.
    uint160 internal constant HOOK_PERMISSION_MASK = 0x22C0;

    function deploy(FleetDeployParams memory p) internal returns (FleetAddresses memory a) {
        FleetRegistry registry = new FleetRegistry(p.members, p.agentManifests, p.fleetManifest);
        FleetVotes token = new FleetVotes(p.tokenName, p.tokenSymbol, registry);

        address[] memory none = new address[](0);
        TimelockController timelock = new TimelockController(p.timelockDelay, none, none, p.deployer);
        TaskLedger ledger = new TaskLedger(address(timelock), p.operator, p.guardian, p.maxTaskLifetime);

        (address predictedHook, bytes32 salt) = HookMiner.find(
            p.create2Deployer,
            HOOK_PERMISSION_MASK,
            type(FleetHook).creationCode,
            abi.encode(registry, ledger, p.deployer)
        );
        FleetHook hook = new FleetHook{salt: salt}(registry, ledger, p.deployer);
        if (address(hook) != predictedHook) revert HookAddressMismatch(predictedHook, address(hook));

        address governor = _deployGovernor(
            p.votingDelay,
            p.votingPeriod,
            p.proposalThreshold,
            p.quorumNumerator,
            address(token),
            address(timelock),
            address(hook)
        );
        hook.initialize(governor);

        timelock.grantRole(timelock.PROPOSER_ROLE(), governor);
        timelock.grantRole(timelock.EXECUTOR_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), governor);
        timelock.grantRole(timelock.CANCELLER_ROLE(), p.guardian);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), p.deployer);

        a = FleetAddresses({
            registry: address(registry),
            token: address(token),
            timelock: address(timelock),
            ledger: address(ledger),
            hook: address(hook),
            governor: governor,
            hookSalt: salt
        });
    }

    /// @dev Deploys the pinned AgoraGovernor from its creation code. Constructor arguments are
    ///      ABI-encoded as addresses, which is byte-identical to `new AgoraGovernor(...)`; we cannot
    ///      use `new` because the `IHooks` type visible to our files differs nominally from the one the
    ///      governor's constructor declares (see docs/compatibility-notes.md, Task 5, Deviation 2).
    function _deployGovernor(
        uint48 votingDelay,
        uint32 votingPeriod,
        uint256 proposalThreshold,
        uint256 quorumNumerator,
        address token,
        address timelock,
        address hook
    ) private returns (address governor) {
        bytes memory initCode = abi.encodePacked(
            type(AgoraGovernor).creationCode,
            abi.encode(votingDelay, votingPeriod, proposalThreshold, quorumNumerator, token, timelock, address(0), address(0), hook)
        );
        assembly ("memory-safe") {
            governor := create(0, add(initCode, 0x20), mload(initCode))
        }
        if (governor == address(0)) revert GovernorDeploymentFailed();
    }
}
