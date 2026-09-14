// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {FleetHook} from "./FleetHook.sol";
import {FleetRegistry} from "./FleetRegistry.sol";
import {TaskLedger} from "./TaskLedger.sol";

/// @notice Executes one exact, zero-value contract call after a fleet exception is recorded.
/// @dev Resources must grant this immutable executor exclusive authority. This does not control
///      an operator's other credentials, HTTP access, or resources with an alternative writer.
contract FleetExecutor {
    struct Permit {
        uint256 taskId;
        uint32 charterVersion;
        address actor;
        address target;
        bytes32 targetCodeHash;
        bytes32 dataHash;
        uint256 nonce;
        uint64 deadline;
    }

    bytes32 public constant PERMIT_DOMAIN = keccak256("fleet.execution-permit.v1");
    uint256 public constant MAX_CALLDATA_BYTES = 8192;
    FleetHook public immutable hook;
    FleetRegistry public immutable registry;
    TaskLedger public immutable ledger;

    mapping(bytes32 payloadHash => bool) public consumed;
    mapping(bytes32 payloadHash => bool) public revoked;
    mapping(address actor => mapping(uint256 nonce => bool)) public usedNonces;
    /// @notice Nonzero only during the approved target call; resources can bind writes to this task.
    uint256 public activeTaskId;
    bool private entered;

    error FleetNotInitialized();
    error NotActor(address caller);
    error NotMember(address actor);
    error NotGuardian(address caller);
    error LedgerPaused();
    error TaskNotOpen(uint256 taskId);
    error Expired();
    error CharterVersionMismatch();
    error CalldataMismatch();
    error TargetCodeMismatch();
    error NotApproved(bytes32 payloadHash);
    error Escalated(bytes32 payloadHash);
    error PermitRevoked(bytes32 payloadHash);
    error AlreadyConsumed(bytes32 payloadHash);
    error NonceAlreadyUsed(address actor, uint256 nonce);
    error ReentrantExecution();
    error TargetCallFailed(bytes reason);

    event PermitExecuted(
        bytes32 indexed payloadHash, uint256 indexed taskId, address indexed actor,
        address target, uint256 nonce, bytes32 dataHash, bytes32 resultHash
    );
    event PermitRevocation(bytes32 indexed payloadHash, address indexed guardian);

    constructor(FleetHook hook_) {
        if (address(hook_.governor()) == address(0) || !hook_.registry().initialized()) revert FleetNotInitialized();
        hook = hook_;
        registry = hook_.registry();
        ledger = hook_.ledger();
    }

    /// @notice The ledger's GRANT_EXCEPTION payload must equal this domain-separated hash.
    function hashPermit(Permit memory permit) public view returns (bytes32) {
        return keccak256(abi.encode(PERMIT_DOMAIN, block.chainid, address(this), address(ledger), permit));
    }

    function execute(Permit calldata permit, bytes calldata data) external returns (bytes memory result) {
        if (entered) revert ReentrantExecution();
        if (msg.sender != permit.actor) revert NotActor(msg.sender);
        if (!registry.isMember(permit.actor)) revert NotMember(permit.actor);
        if (ledger.paused()) revert LedgerPaused();
        TaskLedger.Task memory task = ledger.getTask(permit.taskId);
        if (task.state != TaskLedger.TaskState.Open) revert TaskNotOpen(permit.taskId);
        if (block.timestamp >= task.expiresAt || block.timestamp >= permit.deadline || permit.deadline > task.expiresAt) revert Expired();
        if (task.charterVersion != permit.charterVersion) revert CharterVersionMismatch();
        if (data.length < 4 || data.length > MAX_CALLDATA_BYTES || keccak256(data) != permit.dataHash) revert CalldataMismatch();
        if (permit.target.code.length == 0 || permit.target.codehash != permit.targetCodeHash) revert TargetCodeMismatch();

        bytes32 payloadHash = hashPermit(permit);
        if (revoked[payloadHash]) revert PermitRevoked(payloadHash);
        if (consumed[payloadHash]) revert AlreadyConsumed(payloadHash);
        if (usedNonces[permit.actor][permit.nonce]) revert NonceAlreadyUsed(permit.actor, permit.nonce);
        if (ledger.escalationVersion(permit.taskId, payloadHash) != 0) revert Escalated(payloadHash);
        if (ledger.exceptionVersion(permit.taskId, payloadHash) != permit.charterVersion) revert NotApproved(payloadHash);

        // Effects precede the only external write. A target revert rolls back both the call and
        // consumption, so retrying a failed transaction cannot count as a successful replay.
        entered = true;
        activeTaskId = permit.taskId;
        consumed[payloadHash] = true;
        usedNonces[permit.actor][permit.nonce] = true;
        bool ok;
        (ok, result) = permit.target.call(data);
        if (!ok) revert TargetCallFailed(result);
        entered = false;
        activeTaskId = 0;
        emit PermitExecuted(payloadHash, permit.taskId, permit.actor, permit.target, permit.nonce, permit.dataHash, keccak256(result));
    }

    /// @notice The existing guardian may permanently invalidate an exact permit, never grant one.
    function revoke(bytes32 payloadHash) external {
        if (msg.sender != ledger.guardian()) revert NotGuardian(msg.sender);
        revoked[payloadHash] = true;
        emit PermitRevocation(payloadHash, msg.sender);
    }
}
