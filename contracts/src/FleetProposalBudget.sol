// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ICreditToken} from "./FleetProposalCredits.sol";
import {FleetProposalToken} from "./FleetProposalToken.sol";

/// @notice Deploys one fixed-supply ERC-20 per experiment and burns the proposal fee.
/// @dev Only the Governor's fixed hook can charge, inside the proposal transaction.
///      No agent or operator can mint more tokens, replace the token, or change rules.
contract FleetProposalBudget {
    error NotHook();
    error NotOperator();
    error InvalidRun();
    error RunAlreadyRegistered();
    error RunClosed();
    error NotTokenHolder();
    error NoCredits();
    error AlreadyPaid();
    error InsufficientVotingPower();

    struct Run {
        bytes32 runHash;
        uint64 expiresAt;
        uint8 allowance;
        uint8 proposalCost;
        uint256 proposalThreshold;
    }
    struct Receipt {
        uint256 taskId;
        address proposer;
        uint64 spentAt;
        uint8 cost;
        uint256 votingPower;
    }

    address public immutable governor;
    ICreditToken public immutable token;
    address public immutable operator;
    address public immutable hook;
    mapping(uint256 => Run) public runs;
    mapping(bytes32 => bool) public registered;
    mapping(uint256 => FleetProposalToken) public proposalToken;
    mapping(uint256 => Receipt) public receipts;
    mapping(uint256 => uint256[]) private _proposals;

    event ProposalTokenCreated(uint256 indexed taskId, bytes32 indexed runHash, address indexed proposalToken, uint256 initialSupply);
    event ProposalRules(uint256 indexed taskId, uint8 proposalCost, uint256 proposalThreshold);
    event ProposalCreditSpent(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint8 remaining);

    constructor(address governor_, ICreditToken token_, address operator_, address hook_) {
        require(governor_.code.length > 0 && address(token_).code.length > 0 && operator_ != address(0) && hook_ != address(0), "invalid binding");
        governor = governor_;
        token = token_;
        operator = operator_;
        hook = hook_;
    }

    function registerRunPolicy(uint256 taskId, bytes32 runHash, uint8 allowance, uint64 expiresAt,
        uint8 proposalCost, uint256 proposalThreshold, address[] calldata agents) external
    {
        if (msg.sender != operator) revert NotOperator();
        if (taskId == 0 || runHash == bytes32(0) || allowance == 0 || allowance > 8
            || proposalCost == 0 || proposalCost > allowance || proposalThreshold == 0
            || proposalThreshold > agents.length * 1e18 || agents.length == 0 || agents.length > 64
            || expiresAt <= block.timestamp || expiresAt > block.timestamp + 4 hours) revert InvalidRun();
        if (runs[taskId].expiresAt != 0 || registered[runHash]) revert RunAlreadyRegistered();
        for (uint256 i; i < agents.length; ++i) {
            if (agents[i] == address(0) || token.balanceOf(agents[i]) == 0) revert NotTokenHolder();
            for (uint256 j; j < i; ++j) if (agents[i] == agents[j]) revert InvalidRun();
        }
        runs[taskId] = Run(runHash, expiresAt, allowance, proposalCost, proposalThreshold);
        registered[runHash] = true;
        FleetProposalToken budget = new FleetProposalToken(taskId, runHash, agents, allowance);
        proposalToken[taskId] = budget;
        emit ProposalTokenCreated(taskId, runHash, address(budget), budget.initialSupply());
        emit ProposalRules(taskId, proposalCost, proposalThreshold);
    }

    /// @notice Called during Governor.propose: a successful proposal burns its fee;
    ///         any reverted proposal also rolls back the burn. No outcome-based refund.
    function charge(uint256 taskId, uint256 proposalId, address proposer) external {
        if (msg.sender != hook) revert NotHook();
        Run memory run = runs[taskId];
        if (run.expiresAt == 0 || block.timestamp >= run.expiresAt) revert RunClosed();
        if (token.balanceOf(proposer) == 0) revert NotTokenHolder();
        FleetProposalToken budget = proposalToken[taskId];
        if (budget.balanceOf(proposer) < run.proposalCost) revert NoCredits();
        uint256 power = token.getVotes(proposer);
        if (power < run.proposalThreshold) revert InsufficientVotingPower();
        if (proposalId == 0 || receipts[proposalId].spentAt != 0) revert AlreadyPaid();
        budget.burnForProposal(proposer, run.proposalCost);
        receipts[proposalId] = Receipt(taskId, proposer, uint64(block.timestamp), run.proposalCost, power);
        _proposals[taskId].push(proposalId);
        emit ProposalCreditSpent(taskId, proposalId, proposer, uint8(budget.balanceOf(proposer)));
    }

    function remaining(uint256 taskId, address agent) external view returns (uint8) {
        FleetProposalToken budget = proposalToken[taskId];
        return address(budget) == address(0) ? 0 : uint8(budget.balanceOf(agent));
    }
    function proposalCount(uint256 taskId) external view returns (uint256) { return _proposals[taskId].length; }
    function proposalAt(uint256 taskId, uint256 index) external view returns (uint256) { return _proposals[taskId][index]; }
}
