import { parseAbi } from "viem";

export const proposalCreditsAbi = parseAbi([
  "constructor(address governor_, address token_, address operator_)",
  "function governor() view returns (address)",
  "function token() view returns (address)",
  "function operator() view returns (address)",
  "function runs(uint256) view returns (bytes32 runHash, uint64 expiresAt, uint8 allowance)",
  "function registerRun(uint256 taskId, bytes32 runHash, uint8 allowance, uint64 expiresAt)",
  "function spend(uint256 taskId, uint256 proposalId)",
  "function remaining(uint256 taskId, address agent) view returns (uint8)",
  "function receipts(uint256) view returns (uint256 taskId, address proposer, uint64 spentAt)",
  "function proposalCount(uint256 taskId) view returns (uint256)",
  "function proposalAt(uint256 taskId, uint256 index) view returns (uint256)",
  "event ProposalCreditSpent(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint8 remaining)",
]);
