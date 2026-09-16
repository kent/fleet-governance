// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

interface ICreditToken {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Non-transferable, non-refundable proposal allowances for a fixed task.
/// @dev The existing Governor is unchanged. A Guardian must independently match every
///      task proposal to a paid receipt; an unpaid proposal never authorises compute.
///      Spending happens after an agent drafts its proposal, not during run preparation.
contract FleetProposalCredits {
    error NotOperator();
    error InvalidRun();
    error RunAlreadyRegistered();
    error RunClosed();
    error NotTokenHolder();
    error NoCredits();
    error AlreadyPaid();

    struct Run {
        bytes32 runHash;
        uint64 expiresAt;
        uint8 allowance;
    }
    struct Receipt {
        uint256 taskId;
        address proposer;
        uint64 spentAt;
    }

    address public immutable governor;
    ICreditToken public immutable token;
    address public immutable operator;
    mapping(uint256 taskId => Run) public runs;
    mapping(bytes32 runHash => bool) public registered;
    mapping(uint256 taskId => mapping(address agent => uint8)) public spent;
    mapping(uint256 proposalId => Receipt) public receipts;
    mapping(uint256 taskId => uint256[]) private _proposals;

    event RunRegistered(uint256 indexed taskId, bytes32 indexed runHash, uint8 allowance, uint64 expiresAt);
    event ProposalCreditSpent(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint8 remaining);

    constructor(address governor_, ICreditToken token_, address operator_) {
        require(governor_.code.length > 0 && address(token_).code.length > 0 && operator_ != address(0), "invalid binding");
        governor = governor_;
        token = token_;
        operator = operator_;
    }

    function registerRun(uint256 taskId, bytes32 runHash, uint8 allowance, uint64 expiresAt) external {
        if (msg.sender != operator) revert NotOperator();
        if (taskId == 0 || runHash == bytes32(0) || allowance == 0 || allowance > 8
            || expiresAt <= block.timestamp || expiresAt > block.timestamp + 4 hours) revert InvalidRun();
        if (runs[taskId].expiresAt != 0 || registered[runHash]) revert RunAlreadyRegistered();
        runs[taskId] = Run(runHash, expiresAt, allowance);
        registered[runHash] = true;
        emit RunRegistered(taskId, runHash, allowance, expiresAt);
    }

    /// @notice Consume one credit bound to the agent-authored proposal hash. No refund,
    ///         replenishment or transfer exists, including if publication or voting fails.
    function spend(uint256 taskId, uint256 proposalId) external {
        Run memory run = runs[taskId];
        if (run.expiresAt == 0 || block.timestamp >= run.expiresAt) revert RunClosed();
        if (token.balanceOf(msg.sender) == 0) revert NotTokenHolder();
        if (spent[taskId][msg.sender] >= run.allowance) revert NoCredits();
        if (proposalId == 0 || receipts[proposalId].spentAt != 0) revert AlreadyPaid();
        uint8 used = ++spent[taskId][msg.sender];
        receipts[proposalId] = Receipt(taskId, msg.sender, uint64(block.timestamp));
        _proposals[taskId].push(proposalId);
        emit ProposalCreditSpent(taskId, proposalId, msg.sender, run.allowance - used);
    }

    function remaining(uint256 taskId, address agent) external view returns (uint8) {
        return runs[taskId].allowance - spent[taskId][agent];
    }

    function proposalCount(uint256 taskId) external view returns (uint256) { return _proposals[taskId].length; }
    function proposalAt(uint256 taskId, uint256 index) external view returns (uint256) { return _proposals[taskId][index]; }
}
