// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetExecutor} from "./FleetExecutor.sol";

/// @notice A concrete resource controlled exclusively by its fleet executor. The canonical task
///         artifact cannot be published or replaced through an operator or administrator key.
contract GovernedArtifactStore {
    struct Artifact { bytes32 digest; uint64 revision; }
    address public immutable executor;
    mapping(uint256 taskId => Artifact) public artifacts;

    error NotExecutor(address caller);
    error InvalidExecutor();
    error EmptyArtifact();
    error NoActiveExecution();
    event ArtifactPublished(uint256 indexed taskId, bytes32 indexed digest, uint64 revision);

    constructor(address executor_) {
        if (executor_.code.length == 0) revert InvalidExecutor();
        executor = executor_;
    }

    function publish(bytes32 digest) external {
        if (msg.sender != executor) revert NotExecutor(msg.sender);
        if (digest == bytes32(0)) revert EmptyArtifact();
        uint256 taskId = FleetExecutor(executor).activeTaskId();
        if (taskId == 0) revert NoActiveExecution();
        Artifact storage artifact = artifacts[taskId];
        artifact.digest = digest;
        artifact.revision++;
        emit ArtifactPublished(taskId, digest, artifact.revision);
    }
}
