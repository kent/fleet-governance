import { parseAbi } from "viem";

export const CREDIT_DEPLOYMENT = "contracts/proposal-budget-v3.json";

export const proposalCreditsAbi = parseAbi([
  "function governor() view returns (address)",
  "function token() view returns (address)",
  "function operator() view returns (address)",
  "function hook() view returns (address)",
  "function runs(uint256) view returns (bytes32 runHash, uint64 expiresAt, uint8 allowance, uint8 proposalCost, uint256 proposalThreshold)",
  "function registerRunPolicy(uint256 taskId, bytes32 runHash, uint8 allowance, uint64 expiresAt, uint8 proposalCost, uint256 proposalThreshold, address[] agents)",
  "function proposalToken(uint256 taskId) view returns (address)",
  // Historical credit-ledger evidence only. New Governors charge inside their hook.
  "function spend(uint256 taskId, uint256 proposalId)",
  "function remaining(uint256 taskId, address agent) view returns (uint8)",
  "function receipts(uint256) view returns (uint256 taskId, address proposer, uint64 spentAt, uint8 cost, uint256 votingPower)",
  "function proposalCount(uint256 taskId) view returns (uint256)",
  "function proposalAt(uint256 taskId, uint256 index) view returns (uint256)",
  "event ProposalCreditSpent(uint256 indexed taskId, uint256 indexed proposalId, address indexed proposer, uint8 remaining)",
  "event ProposalTokenCreated(uint256 indexed taskId, bytes32 indexed runHash, address indexed proposalToken, uint256 initialSupply)",
]);

export const proposalBudgetHookAbi = parseAbi(["function proposalBudget() view returns (address)"]);

export const proposalTokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function initialSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function controller() view returns (address)",
  "function taskId() view returns (uint256)",
  "function runHash() view returns (bytes32)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
