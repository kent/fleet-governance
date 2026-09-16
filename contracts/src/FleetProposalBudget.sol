// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {ICreditToken} from "./FleetProposalCredits.sol";
import {FleetProposalToken} from "./FleetProposalToken.sol";

/// @notice Deploys one fixed-supply ERC-20 per experiment and burns the proposal fee.
/// @dev The legacy Governor remains unchanged. The Guardian independently rejects
///      any task proposal without this contract's burn receipt. No agent or operator
///      can mint more tokens, replace the token, or change a registered run's rules.
contract FleetProposalBudget {
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
    mapping(uint256 => Run) public runs;
    mapping(bytes32 => bool) public registered;
    mapping(uint256 => FleetProposalToken) public proposalToken;
    mapping(uint256 => Receipt) public receipts;
    mapping(uint256 => uint256[]) private _proposals;

    event ProposalTokenCreated(uint256 indexed taskId, bytes32 indexed runHash, address indexed proposalToken, uint256 initialSupply);
    event ProposalRules(uint256 indexed taskId, uint8 proposalCost, uint256 proposalThreshold);
    event ProposalCreditSpent(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint8 remaining);

    constructor(address governor_, ICreditToken token_, address operator_) {
        require(governor_.code.length > 0 && address(token_).code.length > 0 && operator_ != address(0), "invalid binding");
        governor = governor_;
        token = token_;
        operator = operator_;
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

    /// @notice Burn the configured FPROP fee and bind it to an exact proposal ID.
    ///         No refunds, including after cancellation, defeat or failed publication.
    function spend(uint256 taskId, uint256 proposalId) external {
        Run memory run = runs[taskId];
        if (run.expiresAt == 0 || block.timestamp >= run.expiresAt) revert RunClosed();
        if (token.balanceOf(msg.sender) == 0) revert NotTokenHolder();
        FleetProposalToken budget = proposalToken[taskId];
        if (budget.balanceOf(msg.sender) < run.proposalCost) revert NoCredits();
        uint256 power = token.getVotes(msg.sender);
        if (power < run.proposalThreshold) revert InsufficientVotingPower();
        if (proposalId == 0 || receipts[proposalId].spentAt != 0) revert AlreadyPaid();
        budget.burnForProposal(msg.sender, run.proposalCost);
        receipts[proposalId] = Receipt(taskId, msg.sender, uint64(block.timestamp), run.proposalCost, power);
        _proposals[taskId].push(proposalId);
        emit ProposalCreditSpent(taskId, proposalId, msg.sender, uint8(budget.balanceOf(msg.sender)));
    }

    function remaining(uint256 taskId, address agent) external view returns (uint8) {
        FleetProposalToken budget = proposalToken[taskId];
        return address(budget) == address(0) ? 0 : uint8(budget.balanceOf(agent));
    }
    function proposalCount(uint256 taskId) external view returns (uint256) { return _proposals[taskId].length; }
    function proposalAt(uint256 taskId, uint256 index) external view returns (uint256) { return _proposals[taskId][index]; }
}
