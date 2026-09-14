// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ActionId} from "./libraries/ActionId.sol";

/// @title TaskLedger
/// @notice Public record of tasks, charters, and fleet decisions. Holds no funds.
/// @dev Decisions are written only by the timelock, which only executes operations the governor
///      scheduled after a successful vote. A recorded decision says the fleet decided, not that
///      the fleet obeyed; obedience is enforced offchain by the gateway in v1.
contract TaskLedger {
    enum TaskState {
        Open,
        Stopped,
        Completed,
        Expired
    }

    enum DecisionKind {
        CHOOSE_PATH,
        GRANT_EXCEPTION,
        AMEND_CHARTER,
        STOP_TASK,
        ESCALATE_TO_HUMAN
    }

    struct Task {
        uint256 id;
        address operator;
        uint64 createdAt;
        uint64 expiresAt;
        TaskState state;
        uint32 charterVersion;
        bytes32 charterHash;
        uint32 decisionCount;
        bool escalated;
    }

    struct Decision {
        uint256 taskId;
        uint32 index;
        DecisionKind kind;
        uint32 charterVersionBefore;
        uint32 charterVersionAfter;
        bytes32 payloadHash;
        bytes32 actionId;
        uint64 recordedAt;
    }

    error NotOperator(address account);
    error NotTimelock(address account);
    error NotGuardian(address account);
    error EnforcedPause();
    error ExpectedPause();
    error UnknownTask(uint256 taskId);
    error UnknownDecision(uint256 taskId, uint32 index);
    error TaskNotOpen(uint256 taskId, TaskState state);
    error TaskExpired(uint256 taskId);
    error TaskNotExpired(uint256 taskId);
    error CharterVersionMismatch(uint32 expected, uint32 actual);
    error InvalidDecisionKind(uint8 kind);
    error CharterTextLengthOutOfRange(uint256 length);
    error CharterTextNotAllowed();
    error CharterHashMismatch(bytes32 expected, bytes32 actual);
    error SummaryTooLong(uint256 length);
    error LifetimeOutOfRange(uint64 lifetime, uint64 min, uint64 max);
    error ZeroAddress();

    event TaskOpened(uint256 indexed taskId, address indexed operator, uint64 expiresAt, bytes32 charterHash, string charterText);
    event DecisionRecorded(
        uint256 indexed taskId,
        uint32 indexed index,
        DecisionKind kind,
        uint32 charterVersionBefore,
        uint32 charterVersionAfter,
        bytes32 payloadHash,
        bytes32 actionId,
        string summary
    );
    event CharterAmended(uint256 indexed taskId, uint32 version, bytes32 charterHash, string charterText);
    event TaskStopped(uint256 indexed taskId, uint32 decisionIndex);
    event TaskCompleted(uint256 indexed taskId);
    event TaskLapsed(uint256 indexed taskId);
    event Paused(address account);
    event Unpaused(address account);

    uint256 public constant MAX_CHARTER_BYTES = 8192;
    uint256 public constant MAX_SUMMARY_BYTES = 1024;
    uint64 public constant MIN_TASK_LIFETIME = 300;

    address public immutable timelock;
    address public immutable operator;
    address public immutable guardian;
    uint64 public immutable maxTaskLifetime;

    bool public paused;
    uint256 public taskCount;

    mapping(uint256 taskId => Task) private _tasks;
    mapping(uint256 taskId => string) private _charterTexts;
    mapping(uint256 taskId => Decision[]) private _decisions;
    /// @notice Charter version at which an exception for this exact action payload was granted; 0 when none.
    mapping(uint256 taskId => mapping(bytes32 payloadHash => uint32 version)) public exceptionVersion;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert NotTimelock(msg.sender);
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian(msg.sender);
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    constructor(address timelock_, address operator_, address guardian_, uint64 maxTaskLifetime_) {
        if (timelock_ == address(0) || operator_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        if (maxTaskLifetime_ < MIN_TASK_LIFETIME) {
            revert LifetimeOutOfRange(maxTaskLifetime_, MIN_TASK_LIFETIME, type(uint64).max);
        }
        timelock = timelock_;
        operator = operator_;
        guardian = guardian_;
        maxTaskLifetime = maxTaskLifetime_;
    }

    function openTask(string calldata charterText_, uint64 lifetime) external onlyOperator whenNotPaused returns (uint256 taskId) {
        uint256 len = bytes(charterText_).length;
        if (len == 0 || len > MAX_CHARTER_BYTES) revert CharterTextLengthOutOfRange(len);
        if (lifetime < MIN_TASK_LIFETIME || lifetime > maxTaskLifetime) {
            revert LifetimeOutOfRange(lifetime, MIN_TASK_LIFETIME, maxTaskLifetime);
        }
        taskId = ++taskCount;
        bytes32 charterHash = keccak256(bytes(charterText_));
        uint64 expiresAt = uint64(block.timestamp) + lifetime;
        _tasks[taskId] = Task({
            id: taskId,
            operator: msg.sender,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            state: TaskState.Open,
            charterVersion: 1,
            charterHash: charterHash,
            decisionCount: 0,
            escalated: false
        });
        _charterTexts[taskId] = charterText_;
        emit TaskOpened(taskId, msg.sender, expiresAt, charterHash, charterText_);
    }

    function recordDecision(
        uint256 taskId,
        uint8 kind,
        uint32 expectedVersion,
        bytes32 payloadHash,
        string calldata newCharterText,
        string calldata summary
    ) external onlyTimelock whenNotPaused {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        if (block.timestamp >= task.expiresAt) revert TaskExpired(taskId);
        if (expectedVersion != task.charterVersion) revert CharterVersionMismatch(expectedVersion, task.charterVersion);
        if (kind > uint8(DecisionKind.ESCALATE_TO_HUMAN)) revert InvalidDecisionKind(kind);
        if (bytes(summary).length > MAX_SUMMARY_BYTES) revert SummaryTooLong(bytes(summary).length);

        DecisionKind decisionKind = DecisionKind(kind);
        uint32 versionBefore = task.charterVersion;
        uint32 versionAfter = versionBefore;

        if (decisionKind == DecisionKind.AMEND_CHARTER) {
            versionAfter = _applyAmendment(task, taskId, payloadHash, newCharterText, versionBefore);
        } else if (bytes(newCharterText).length != 0) {
            revert CharterTextNotAllowed();
        }

        _finalizeDecision(task, taskId, kind, expectedVersion, payloadHash, summary, decisionKind, versionBefore, versionAfter);
    }

    /// @dev Split out of recordDecision to keep that function's stack shallow enough for the
    ///      legacy (non via-IR) codegen; behavior is identical to inlining it. Applies the
    ///      exception/stop/escalation side effects, computes the actionId, and records the
    ///      Decision and its events.
    function _finalizeDecision(
        Task storage task,
        uint256 taskId,
        uint8 kind,
        uint32 expectedVersion,
        bytes32 payloadHash,
        string calldata summary,
        DecisionKind decisionKind,
        uint32 versionBefore,
        uint32 versionAfter
    ) private {
        if (decisionKind == DecisionKind.GRANT_EXCEPTION) exceptionVersion[taskId][payloadHash] = versionBefore;
        if (decisionKind == DecisionKind.STOP_TASK) task.state = TaskState.Stopped;
        task.escalated = decisionKind == DecisionKind.ESCALATE_TO_HUMAN;

        bytes32 actionId = ActionId.compute(address(this), taskId, kind, expectedVersion, payloadHash);
        uint32 index = task.decisionCount;
        task.decisionCount = index + 1;
        Decision storage d = _decisions[taskId].push();
        d.taskId = taskId;
        d.index = index;
        d.kind = decisionKind;
        d.charterVersionBefore = versionBefore;
        d.charterVersionAfter = versionAfter;
        d.payloadHash = payloadHash;
        d.actionId = actionId;
        d.recordedAt = uint64(block.timestamp);
        emit DecisionRecorded(taskId, index, decisionKind, versionBefore, versionAfter, payloadHash, actionId, summary);
        if (decisionKind == DecisionKind.STOP_TASK) emit TaskStopped(taskId, index);
    }

    /// @dev Split out of recordDecision to keep that function's stack shallow enough for the
    ///      legacy (non via-IR) codegen; behavior is identical to inlining it.
    function _applyAmendment(
        Task storage task,
        uint256 taskId,
        bytes32 payloadHash,
        string calldata newCharterText,
        uint32 versionBefore
    ) private returns (uint32 versionAfter) {
        uint256 len = bytes(newCharterText).length;
        if (len == 0 || len > MAX_CHARTER_BYTES) revert CharterTextLengthOutOfRange(len);
        bytes32 newHash = keccak256(bytes(newCharterText));
        if (newHash != payloadHash) revert CharterHashMismatch(payloadHash, newHash);
        versionAfter = versionBefore + 1;
        task.charterVersion = versionAfter;
        task.charterHash = newHash;
        _charterTexts[taskId] = newCharterText;
        emit CharterAmended(taskId, versionAfter, newHash, newCharterText);
    }

    function completeTask(uint256 taskId) external onlyOperator {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        task.state = TaskState.Completed;
        emit TaskCompleted(taskId);
    }

    /// @notice Anyone may mark an expired task for indexing clarity. Funding-path safety never depends on it:
    ///         recordDecision checks the timestamp directly.
    function expireTask(uint256 taskId) external {
        Task storage task = _task(taskId);
        if (task.state != TaskState.Open) revert TaskNotOpen(taskId, task.state);
        if (block.timestamp < task.expiresAt) revert TaskNotExpired(taskId);
        task.state = TaskState.Expired;
        emit TaskLapsed(taskId);
    }

    function pause() external onlyGuardian {
        if (paused) revert EnforcedPause();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyGuardian {
        if (!paused) revert ExpectedPause();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function getTask(uint256 taskId) external view returns (Task memory) {
        return _task(taskId);
    }

    function charterText(uint256 taskId) external view returns (string memory) {
        _task(taskId);
        return _charterTexts[taskId];
    }

    function getDecision(uint256 taskId, uint32 index) external view returns (Decision memory) {
        _task(taskId);
        if (index >= _decisions[taskId].length) revert UnknownDecision(taskId, index);
        return _decisions[taskId][index];
    }

    function decisionCount(uint256 taskId) external view returns (uint256) {
        return _task(taskId).decisionCount;
    }

    function _task(uint256 taskId) private view returns (Task storage task) {
        task = _tasks[taskId];
        if (task.id == 0) revert UnknownTask(taskId);
    }
}
