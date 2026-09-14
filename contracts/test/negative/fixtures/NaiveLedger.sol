// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// @title NaiveLedger
/// @notice NOT FOR DEPLOYMENT. Test-only fixture for test/negative/FrontendOnly.t.sol.
/// @dev Mirrors the shape of TaskLedger.recordDecision with its onlyTimelock modifier removed.
///      whenNotPaused is kept for shape but nothing here ever sets paused, so it never blocks a
///      call; the point of this fixture is solely to show what onlyTimelock buys: without it,
///      anyone can call recordDecision directly, no matter what a frontend does or does not let
///      them click. Only the minimal state needed to show a decision was recorded is kept; this is
///      not a functional copy of TaskLedger's charter/task bookkeeping.
contract NaiveLedger {
    error EnforcedPause();

    event TaskOpened(uint256 indexed taskId, address indexed opener);
    event DecisionRecorded(uint256 indexed taskId, uint32 indexed index, uint8 kind);

    bool public paused;
    uint256 public taskCount;
    mapping(uint256 taskId => uint32) public decisionCount;

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    /// @dev Callable by anyone, unlike TaskLedger.openTask's onlyOperator: the demonstration this
    ///      fixture exists for is about recordDecision, so task creation is left open on purpose to
    ///      keep the fixture minimal rather than to make a separate point.
    function openTask() external whenNotPaused returns (uint256 taskId) {
        taskId = ++taskCount;
        emit TaskOpened(taskId, msg.sender);
    }

    /// @dev The onlyTimelock modifier TaskLedger.recordDecision carries is removed here on purpose;
    ///      this is the boundary the demonstration exists to show.
    function recordDecision(
        uint256 taskId,
        uint8 kind,
        uint32, /* expectedVersion */
        bytes32, /* payloadHash */
        string calldata, /* newCharterText */
        string calldata /* summary */
    )
        external
        whenNotPaused
        returns (uint32 index)
    {
        index = decisionCount[taskId];
        decisionCount[taskId] = index + 1;
        emit DecisionRecorded(taskId, index, kind);
    }
}
