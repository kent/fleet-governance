// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Script, console2} from "forge-std/Script.sol";
import {FleetDeployer, FleetDeployParams, FleetAddresses} from "../src/deploy/FleetDeployer.sol";

/// @notice Reads a fleet config JSON, deploys the full sequence to whatever chain `--rpc-url`
///         points at, and writes a manifest describing the result. See deployments/configs for
///         example configs and docs/compatibility-notes.md for the JSON serializer behaviour this
///         relies on.
contract DeployFleet is Script {
    function run() external returns (FleetAddresses memory a) {
        string memory cfgPath = vm.envString("FLEET_DEPLOY_CONFIG");
        string memory json = vm.readFile(cfgPath);
        uint256 pk = vm.envUint("FLEET_DEPLOYER_KEY");

        FleetDeployParams memory p;
        p.tokenName = vm.parseJsonString(json, ".tokenName");
        p.tokenSymbol = vm.parseJsonString(json, ".tokenSymbol");
        p.members = vm.parseJsonAddressArray(json, ".members");
        p.agentManifests = vm.parseJsonStringArray(json, ".agentManifests");
        p.fleetManifest = vm.parseJsonString(json, ".fleetManifest");
        p.operator = vm.parseJsonAddress(json, ".operator");
        p.guardian = vm.parseJsonAddress(json, ".guardian");
        p.votingDelay = uint48(vm.parseJsonUint(json, ".votingDelay"));
        p.votingPeriod = uint32(vm.parseJsonUint(json, ".votingPeriod"));
        p.proposalThreshold = vm.parseJsonUint(json, ".proposalThreshold");
        p.quorumNumerator = vm.parseJsonUint(json, ".quorumNumerator");
        p.timelockDelay = vm.parseJsonUint(json, ".timelockDelay");
        p.maxTaskLifetime = uint64(vm.parseJsonUint(json, ".maxTaskLifetime"));
        p.create2Deployer = CREATE2_FACTORY;
        p.deployer = vm.addr(pk);

        uint256 startBlock = block.number;
        vm.startBroadcast(pk);
        a = FleetDeployer.deploy(p);
        vm.stopBroadcast();

        _writeManifest(json, p, a, startBlock);
        console2.log("registry", a.registry);
        console2.log("token", a.token);
        console2.log("timelock", a.timelock);
        console2.log("ledger", a.ledger);
        console2.log("hook", a.hook);
        console2.log("governor", a.governor);
    }

    function _writeManifest(
        string memory cfgJson,
        FleetDeployParams memory p,
        FleetAddresses memory a,
        uint256 startBlock
    ) internal {
        string memory root = "manifest";
        vm.serializeString(root, "schema", "fleet.manifest.v1");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "deploymentBlock", startBlock);
        vm.serializeAddress(root, "deployer", p.deployer);
        vm.serializeBytes32(root, "hookSalt", a.hookSalt);
        vm.serializeString(root, "countingRule", "for-only-quorum");
        vm.serializeString(root, "hookPermissionMask", "0x22c0");
        vm.serializeBytes32(root, "configHash", keccak256(bytes(cfgJson)));

        string memory addrs = "addresses";
        vm.serializeAddress(addrs, "registry", a.registry);
        vm.serializeAddress(addrs, "token", a.token);
        vm.serializeAddress(addrs, "timelock", a.timelock);
        vm.serializeAddress(addrs, "ledger", a.ledger);
        vm.serializeAddress(addrs, "hook", a.hook);
        string memory addrsJson = vm.serializeAddress(addrs, "governor", a.governor);
        vm.serializeString(root, "addresses", addrsJson);

        string memory params = "params";
        vm.serializeUint(params, "votingDelay", p.votingDelay);
        vm.serializeUint(params, "votingPeriod", p.votingPeriod);
        vm.serializeUint(params, "proposalThreshold", p.proposalThreshold);
        vm.serializeUint(params, "quorumNumerator", p.quorumNumerator);
        vm.serializeUint(params, "timelockDelay", p.timelockDelay);
        string memory paramsJson = vm.serializeUint(params, "maxTaskLifetime", p.maxTaskLifetime);
        vm.serializeString(root, "params", paramsJson);

        string memory compiler = "compiler";
        vm.serializeString(compiler, "solc", "0.8.29");
        vm.serializeString(compiler, "evm", "cancun");
        string memory compilerJson = vm.serializeUint(compiler, "optimizerRuns", 200);
        vm.serializeString(root, "compiler", compilerJson);

        string memory pins = "pins";
        vm.serializeString(pins, "agoraGovernor", "11a11641ce1f4f691c300d530eae3c7203593b85");
        string memory pinsJson = vm.serializeString(pins, "openzeppelin", "3d139e998b9843179d72b28a3264834b01baf160");
        vm.serializeString(root, "pins", pinsJson);

        string memory hashes = "codeHashes";
        vm.serializeBytes32(hashes, "registry", a.registry.codehash);
        vm.serializeBytes32(hashes, "token", a.token.codehash);
        vm.serializeBytes32(hashes, "timelock", a.timelock.codehash);
        vm.serializeBytes32(hashes, "ledger", a.ledger.codehash);
        vm.serializeBytes32(hashes, "hook", a.hook.codehash);
        string memory hashesJson = vm.serializeBytes32(hashes, "governor", a.governor.codehash);
        string memory out = vm.serializeString(root, "codeHashes", hashesJson);

        string memory dir = string.concat("../deployments/", vm.toString(block.chainid));
        string memory path = vm.envOr("FLEET_MANIFEST_OUT", string.concat(dir, "/latest.json"));
        vm.createDir(dir, true);
        vm.writeJson(out, path);
        console2.log("manifest", path);
    }
}
