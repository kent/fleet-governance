// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IHooks} from "agora-governor/src/interfaces/IHooks.sol";
import {Hooks} from "agora-governor/src/libraries/Hooks.sol";
import {AgoraGovernor} from "agora-governor/src/AgoraGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {FleetRegistry} from "./FleetRegistry.sol";
import {TaskLedger} from "./TaskLedger.sol";
import {ActionId} from "./libraries/ActionId.sol";

/// @title FleetHook
/// @notice Every fleet governance rule, attached to an unmodified Agora Governor through its hook system.
/// @dev Permission mask 0x22C0: beforeVoteSucceeded (1<<13), beforeVote (1<<9), beforePropose (1<<7),
///      afterPropose (1<<6). The address must carry exactly those bits; deploy with CREATE2 at a mined salt.
///      The governor calls hooks with `sender` = its own msg.sender (the proposer or voter) and the hook's
///      msg.sender is the governor.
contract FleetHook is IHooks {
    error NotInitializer(address account);
    error AlreadyInitialized();
    error NotInitialized();
    error GovernorHookMismatch(address governor);
    error NotGovernor(address account);
    error HookNotImplemented();
    error NotMember(address account);
    error InvalidActionCount(uint256 count);
    error InvalidTarget(address target);
    error NonZeroValue(uint256 value);
    error InvalidSelector(bytes4 selector);
    error MalformedCalldata();
    error DescriptionLengthOutOfRange(uint256 length);
    error ReasonLengthOutOfRange(uint256 length);
    error ParamsNotAllowed();
    error InvalidSupport(uint8 support);
    error NoVotingPower(address account);
    error LedgerPaused();
    error TaskNotOpen(uint256 taskId);
    error TaskExpired(uint256 taskId);
    error CharterVersionMismatch(uint32 expected, uint32 actual);
    error InvalidDecisionKind(uint8 kind);
    error CharterTextInvalid(uint256 length);
    error CharterTextNotAllowed();
    error CharterHashMismatch(bytes32 expected, bytes32 actual);
    error SummaryTooLong(uint256 length);
    error InsufficientTaskTime(uint256 remaining, uint256 required);
    error MemberHasUnsettledProposal(address member, uint256 taskId, uint256 proposalId);

    event Initialized(address governor);
    event DecisionProposed(
        uint256 indexed proposalId,
        uint256 indexed taskId,
        uint8 kind,
        uint32 expectedVersion,
        bytes32 payloadHash,
        bytes32 actionId,
        address indexed proposer
    );

    struct DecodedAction {
        uint256 taskId;
        uint8 kind;
        uint32 expectedVersion;
        bytes32 payloadHash;
        string newCharterText;
        string summary;
    }

    uint160 public constant PERMISSION_MASK = 0x22C0;
    uint256 public constant MAX_DESCRIPTION_BYTES = 4096;
    uint256 public constant MAX_REASON_BYTES = 1024;
    uint256 public constant EXECUTION_MARGIN = 60;

    FleetRegistry public immutable registry;
    TaskLedger public immutable ledger;
    address public immutable initializer;

    AgoraGovernor public governor;

    mapping(uint256 proposalId => bytes32 actionId) public actionOf;
    mapping(uint256 proposalId => uint256 taskId) public taskOf;
    mapping(uint256 taskId => mapping(address member => uint256 proposalId)) public lastProposalOf;

    modifier onlyGovernor() {
        if (address(governor) == address(0)) revert NotInitialized();
        if (msg.sender != address(governor)) revert NotGovernor(msg.sender);
        _;
    }

    constructor(FleetRegistry registry_, TaskLedger ledger_, address initializer_) {
        registry = registry_;
        ledger = ledger_;
        initializer = initializer_;
        _validateHookPermissions();
    }

    /// @dev Equivalent to Hooks.validateHookPermissions(IHooks(address(this)), getHookPermissions()), checked
    ///      directly against the flag bits instead of going through the library call. The library's `self`
    ///      parameter type is bound to the IHooks declared inside the pinned Agora submodule's own import
    ///      context; a value built from our own import of the identical interface file does not typecheck
    ///      against it (solc treats the two as distinct nominal types), so the equivalent check is inlined here.
    function _validateHookPermissions() private view {
        Hooks.Permissions memory permissions = getHookPermissions();
        uint160 addr = uint160(address(this));
        bool ok = permissions.beforeInitialize == (addr & Hooks.BEFORE_INITIALIZE_FLAG != 0)
            && permissions.afterInitialize == (addr & Hooks.AFTER_INITIALIZE_FLAG != 0)
            && permissions.beforeVoteSucceeded == (addr & Hooks.BEFORE_VOTE_SUCCEEDED_FLAG != 0)
            && permissions.afterVoteSucceeded == (addr & Hooks.AFTER_VOTE_SUCCEEDED_FLAG != 0)
            && permissions.beforeQuorumCalculation == (addr & Hooks.BEFORE_QUORUM_CALCULATION_FLAG != 0)
            && permissions.afterQuorumCalculation == (addr & Hooks.AFTER_QUORUM_CALCULATION_FLAG != 0)
            && permissions.beforeVote == (addr & Hooks.BEFORE_VOTE_FLAG != 0)
            && permissions.afterVote == (addr & Hooks.AFTER_VOTE_FLAG != 0)
            && permissions.beforePropose == (addr & Hooks.BEFORE_PROPOSE_FLAG != 0)
            && permissions.afterPropose == (addr & Hooks.AFTER_PROPOSE_FLAG != 0)
            && permissions.beforeCancel == (addr & Hooks.BEFORE_CANCEL_FLAG != 0)
            && permissions.afterCancel == (addr & Hooks.AFTER_CANCEL_FLAG != 0)
            && permissions.beforeQueue == (addr & Hooks.BEFORE_QUEUE_FLAG != 0)
            && permissions.afterQueue == (addr & Hooks.AFTER_QUEUE_FLAG != 0)
            && permissions.beforeExecute == (addr & Hooks.BEFORE_EXECUTE_FLAG != 0)
            && permissions.afterExecute == (addr & Hooks.AFTER_EXECUTE_FLAG != 0);
        if (!ok) revert Hooks.HookAddressNotValid(address(this));
    }

    function initialize(address governor_) external {
        if (msg.sender != initializer) revert NotInitializer(msg.sender);
        if (address(governor) != address(0)) revert AlreadyInitialized();
        if (address(AgoraGovernor(payable(governor_)).hooks()) != address(this)) revert GovernorHookMismatch(governor_);
        governor = AgoraGovernor(payable(governor_));
        emit Initialized(governor_);
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory permissions) {
        permissions.beforeVoteSucceeded = true;
        permissions.beforeVote = true;
        permissions.beforePropose = true;
        permissions.afterPropose = true;
    }

    // ---------------------------------------------------------------------
    // Proposal admission
    // ---------------------------------------------------------------------

    function beforePropose(
        address sender,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) external view override onlyGovernor returns (bytes4, uint256) {
        if (!registry.isMember(sender)) revert NotMember(sender);
        if (targets.length != 1 || values.length != 1 || calldatas.length != 1) revert InvalidActionCount(targets.length);
        if (targets[0] != address(ledger)) revert InvalidTarget(targets[0]);
        if (values[0] != 0) revert NonZeroValue(values[0]);
        uint256 descriptionLength = bytes(description).length;
        if (descriptionLength == 0 || descriptionLength > MAX_DESCRIPTION_BYTES) {
            revert DescriptionLengthOutOfRange(descriptionLength);
        }

        DecodedAction memory action = decodeAction(calldatas[0]);
        _validateAgainstLedger(action);
        return (IHooks.beforePropose.selector, 0);
    }

    function afterPropose(
        address,
        uint256 proposalId,
        address[] memory,
        uint256[] memory,
        bytes[] memory calldatas,
        string memory
    ) external override onlyGovernor returns (bytes4) {
        DecodedAction memory action = decodeAction(calldatas[0]);
        address proposer = governor.proposalProposer(proposalId);

        uint256 previous = lastProposalOf[action.taskId][proposer];
        if (previous != 0 && _isUnsettled(governor.state(previous))) {
            revert MemberHasUnsettledProposal(proposer, action.taskId, previous);
        }

        bytes32 actionId =
            ActionId.compute(address(ledger), action.taskId, action.kind, action.expectedVersion, action.payloadHash);
        actionOf[proposalId] = actionId;
        taskOf[proposalId] = action.taskId;
        lastProposalOf[action.taskId][proposer] = proposalId;

        emit DecisionProposed(
            proposalId, action.taskId, action.kind, action.expectedVersion, action.payloadHash, actionId, proposer
        );
        return IHooks.afterPropose.selector;
    }

    // ---------------------------------------------------------------------
    // Vote admission and success rule
    // ---------------------------------------------------------------------

    function beforeVote(
        address,
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory params
    ) external view override onlyGovernor returns (bytes4, bool, uint256) {
        if (params.length != 0) revert ParamsNotAllowed();
        if (support > 2) revert InvalidSupport(support);
        if (!registry.isMember(account)) revert NotMember(account);
        uint256 reasonLength = bytes(reason).length;
        if (reasonLength == 0 || reasonLength > MAX_REASON_BYTES) revert ReasonLengthOutOfRange(reasonLength);
        if (governor.getVotes(account, governor.proposalSnapshot(proposalId)) == 0) revert NoVotingPower(account);
        return (IHooks.beforeVote.selector, false, 0);
    }

    /// @notice For-only quorum: For must reach quorum(proposalId) on its own and exceed Against.
    function beforeVoteSucceeded(address, uint256 proposalId) external view override returns (bytes4, bool, bool) {
        (uint256 againstVotes, uint256 forVotes,) = governor.proposalVotes(proposalId);
        bool succeeded = forVotes >= governor.quorum(proposalId) && forVotes > againstVotes;
        return (IHooks.beforeVoteSucceeded.selector, true, succeeded);
    }

    // ---------------------------------------------------------------------
    // Decoding helpers
    // ---------------------------------------------------------------------

    /// @notice Decodes recordDecision calldata and rejects anything that does not re-encode to identical bytes.
    function decodeAction(bytes memory data) public pure returns (DecodedAction memory action) {
        if (data.length < 4) revert MalformedCalldata();
        bytes4 selector = bytes4(data);
        if (selector != TaskLedger.recordDecision.selector) revert InvalidSelector(selector);
        bytes memory args = _tail(data);
        (action.taskId, action.kind, action.expectedVersion, action.payloadHash, action.newCharterText, action.summary) =
            abi.decode(args, (uint256, uint8, uint32, bytes32, string, string));
        bytes memory canonical = abi.encodeWithSelector(
            selector,
            action.taskId,
            action.kind,
            action.expectedVersion,
            action.payloadHash,
            action.newCharterText,
            action.summary
        );
        if (keccak256(canonical) != keccak256(data)) revert MalformedCalldata();
    }

    function _validateAgainstLedger(DecodedAction memory action) internal view {
        if (ledger.paused()) revert LedgerPaused();
        TaskLedger.Task memory task = ledger.getTask(action.taskId);
        if (task.state != TaskLedger.TaskState.Open) revert TaskNotOpen(action.taskId);
        if (block.timestamp >= task.expiresAt) revert TaskExpired(action.taskId);
        if (action.expectedVersion != task.charterVersion) {
            revert CharterVersionMismatch(action.expectedVersion, task.charterVersion);
        }
        if (action.kind > uint8(TaskLedger.DecisionKind.ESCALATE_TO_HUMAN)) revert InvalidDecisionKind(action.kind);

        uint256 charterLength = bytes(action.newCharterText).length;
        if (action.kind == uint8(TaskLedger.DecisionKind.AMEND_CHARTER)) {
            if (charterLength == 0 || charterLength > ledger.MAX_CHARTER_BYTES()) revert CharterTextInvalid(charterLength);
            bytes32 newHash = keccak256(bytes(action.newCharterText));
            if (newHash != action.payloadHash) revert CharterHashMismatch(action.payloadHash, newHash);
        } else if (charterLength != 0) {
            revert CharterTextNotAllowed();
        }
        uint256 summaryLength = bytes(action.summary).length;
        if (summaryLength > ledger.MAX_SUMMARY_BYTES()) revert SummaryTooLong(summaryLength);

        uint256 required = governor.votingDelay() + governor.votingPeriod()
            + TimelockController(payable(governor.timelock())).getMinDelay() + EXECUTION_MARGIN;
        uint256 remaining = task.expiresAt - block.timestamp;
        if (remaining < required) revert InsufficientTaskTime(remaining, required);
    }

    function _isUnsettled(IGovernor.ProposalState state) internal pure returns (bool) {
        return state == IGovernor.ProposalState.Pending || state == IGovernor.ProposalState.Active
            || state == IGovernor.ProposalState.Succeeded || state == IGovernor.ProposalState.Queued;
    }

    /// @dev Copies `data[4:]` into a fresh bytes array using MCOPY (cancun).
    function _tail(bytes memory data) private pure returns (bytes memory out) {
        assembly ("memory-safe") {
            let len := sub(mload(data), 4)
            out := mload(0x40)
            mstore(out, len)
            mcopy(add(out, 0x20), add(data, 0x24), len)
            mstore(0x40, add(out, and(add(add(len, 0x20), 0x1f), not(0x1f))))
        }
    }

    // ---------------------------------------------------------------------
    // Hooks this contract does not request. The governor never calls them because the address
    // lacks their permission bits; they revert so a misconfigured deployment fails loudly.
    // ---------------------------------------------------------------------

    function beforeInitialize(address) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterInitialize(address) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterVoteSucceeded(address, uint256, bool) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeQuorumCalculation(address, uint256) external pure override returns (bytes4, uint256) { revert HookNotImplemented(); }
    function afterQuorumCalculation(address, uint256, uint256) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function afterVote(address, uint256, uint256, address, uint8, string memory, bytes memory) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeCancel(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, uint256) { revert HookNotImplemented(); }
    function afterCancel(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeQueue(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, address[] memory, uint256[] memory, bytes[] memory, bytes32) { revert HookNotImplemented(); }
    function afterQueue(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
    function beforeExecute(address, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4, bool) { revert HookNotImplemented(); }
    function afterExecute(address, uint256, address[] memory, uint256[] memory, bytes[] memory, bytes32) external pure override returns (bytes4) { revert HookNotImplemented(); }
}
