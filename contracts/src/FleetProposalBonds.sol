// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {FleetBondVotes} from "./FleetBondVotes.sol";

/// @notice Atomic FleetGov bonds. Losing a well-attended vote does not forfeit a bond.
contract FleetProposalBonds {
    error NotHook();
    error NotOperator();
    error InvalidRun();
    error RunAlreadyRegistered();
    error PreviousRunOpen();
    error RunClosed();
    error NotParticipant();
    error InsufficientVotingPower();
    error CooldownActive();
    error ProposalLimit();
    error AlreadyBonded();
    error UnknownProposal();
    error VotingNotFinished();
    error BondsOutstanding();

    uint256 public constant MAX_PROPOSALS = 64;

    struct Run {
        bytes32 runHash;
        uint64 expiresAt;
        uint256 bondAmount;
        uint256 proposalThreshold;
        uint32 cooldownSeconds;
        uint16 participationBps;
        bool closed;
    }

    // settlement: 0 reserved, 1 returned, 2 forfeited.
    struct Receipt {
        uint256 taskId;
        address proposer;
        uint64 bondedAt;
        uint256 amount;
        uint256 votingPower;
        uint8 settlement;
    }
    AgoraGovernor public immutable governor;
    FleetBondVotes public immutable token;
    address public immutable operator;
    address public immutable hook;
    uint256 public currentTaskId;
    mapping(uint256 => Run) public runs;
    mapping(bytes32 => bool) public registered;
    mapping(uint256 => Receipt) public receipts;
    mapping(uint256 => mapping(address => bool)) public participants;
    mapping(uint256 => mapping(address => uint64)) public lastProposedAt;
    mapping(uint256 => uint256[]) private _proposals;

    event BondRulesRegistered(
        uint256 indexed taskId,
        bytes32 indexed runHash,
        uint256 bondAmount,
        uint256 proposalThreshold,
        uint32 cooldownSeconds,
        uint16 participationBps,
        uint64 expiresAt
    );
    event ProposalBonded(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint256 amount);
    event ProposalBondSettled(
        uint256 indexed taskId,
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 amount,
        uint8 settlement,
        uint256 participation,
        uint256 requiredParticipation
    );
    event RunClosedPermanently(uint256 indexed taskId);

    constructor(address governor_, FleetBondVotes token_, address operator_, address hook_) {
        require(
            governor_.code.length > 0 && address(token_).code.length > 0 && operator_ != address(0)
                && hook_ != address(0),
            "invalid binding"
        );
        governor = AgoraGovernor(payable(governor_));
        token = token_;
        operator = operator_;
        hook = hook_;
    }

    function registerRunPolicy(
        uint256 taskId,
        bytes32 runHash,
        uint64 expiresAt,
        uint256 bondAmount,
        uint256 proposalThreshold,
        uint32 cooldownSeconds,
        uint16 participationBps,
        address[] calldata agents
    ) external {
        if (msg.sender != operator) revert NotOperator();
        if (
            taskId == 0 || runHash == bytes32(0) || expiresAt <= block.timestamp
                || expiresAt > block.timestamp + 4 hours || bondAmount == 0 || bondAmount > 1e18
                || proposalThreshold == 0 || proposalThreshold > agents.length * 1e18 || cooldownSeconds < 30
                || cooldownSeconds > 600 || participationBps < 1000 || participationBps > 10000 || agents.length == 0
                || agents.length > 64
        ) revert InvalidRun();
        if (runs[taskId].expiresAt != 0 || registered[runHash]) revert RunAlreadyRegistered();
        if (currentTaskId != 0 && !runs[currentTaskId].closed) revert PreviousRunOpen();
        if (token.totalBonded() != 0) revert BondsOutstanding();
        for (uint256 i; i < agents.length; ++i) {
            if (!token.registry().isMember(agents[i]) || participants[taskId][agents[i]]) revert NotParticipant();
            participants[taskId][agents[i]] = true;
        }
        // A human-authorised fresh run resets the fixed electorate by redistributing
        // its existing treasury tokens, never by minting or reopening an old policy.
        for (uint256 i; i < token.registry().memberCount(); ++i) {
            token.resetExperimentBalance(token.registry().accountOf(i));
        }
        runs[taskId] = Run(runHash, expiresAt, bondAmount, proposalThreshold, cooldownSeconds, participationBps, false);
        registered[runHash] = true;
        currentTaskId = taskId;
        emit BondRulesRegistered(
            taskId, runHash, bondAmount, proposalThreshold, cooldownSeconds, participationBps, expiresAt
        );
    }

    function bond(uint256 taskId, uint256 proposalId, address proposer) external {
        if (msg.sender != hook) revert NotHook();
        Run memory run = runs[taskId];
        if (run.expiresAt == 0 || run.closed || block.timestamp >= run.expiresAt) revert RunClosed();
        if (!participants[taskId][proposer]) revert NotParticipant();
        if (receipts[proposalId].bondedAt != 0 || proposalId == 0) revert AlreadyBonded();
        if (_proposals[taskId].length >= MAX_PROPOSALS) revert ProposalLimit();
        uint64 previous = lastProposedAt[taskId][proposer];
        if (previous != 0 && block.timestamp < uint256(previous) + run.cooldownSeconds) revert CooldownActive();
        uint256 power = token.getVotes(proposer);
        if (power < run.proposalThreshold) revert InsufficientVotingPower();
        token.lockBond(proposer, run.bondAmount);
        receipts[proposalId] = Receipt(taskId, proposer, uint64(block.timestamp), run.bondAmount, power, 0);
        lastProposedAt[taskId][proposer] = uint64(block.timestamp);
        _proposals[taskId].push(proposalId);
        emit ProposalBonded(taskId, proposalId, proposer, run.bondAmount);
    }

    /// @notice Permissionless and idempotent. Works after the worker is stopped.
    function settle(uint256 proposalId) public returns (uint8 outcome) {
        Receipt storage receipt = receipts[proposalId];
        if (receipt.bondedAt == 0) revert UnknownProposal();
        if (receipt.settlement != 0) return receipt.settlement;
        IGovernor.ProposalState state = governor.state(proposalId);
        if (state == IGovernor.ProposalState.Pending || state == IGovernor.ProposalState.Active) {
            revert VotingNotFinished();
        }
        uint256 participation;
        uint256 required;
        if (state != IGovernor.ProposalState.Canceled) {
            (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes) = governor.proposalVotes(proposalId);
            participation = againstVotes + forVotes + abstainVotes;
            uint256 supply = token.getPastTotalSupply(governor.proposalSnapshot(proposalId));
            required = (supply * runs[receipt.taskId].participationBps + 9999) / 10000;
        }
        outcome = state != IGovernor.ProposalState.Canceled && required != 0 && participation >= required ? 1 : 2;
        receipt.settlement = outcome;
        token.resolveBond(receipt.proposer, receipt.amount, outcome == 2);
        emit ProposalBondSettled(
            receipt.taskId, proposalId, receipt.proposer, receipt.amount, outcome, participation, required
        );
    }

    /// @notice Called by protected CI after it verifies the allocation is stopped.
    ///         Closing cannot grant more time or reopen a failed experiment.
    function closeRun(uint256 taskId) external {
        if (msg.sender != operator) revert NotOperator();
        if (runs[taskId].expiresAt == 0) revert InvalidRun();
        for (uint256 i; i < _proposals[taskId].length; ++i) {
            if (receipts[_proposals[taskId][i]].settlement == 0) revert BondsOutstanding();
        }
        runs[taskId].closed = true;
        emit RunClosedPermanently(taskId);
    }

    function proposalCount(uint256 taskId) external view returns (uint256) {
        return _proposals[taskId].length;
    }

    function proposalAt(uint256 taskId, uint256 index) external view returns (uint256) {
        return _proposals[taskId][index];
    }
}
