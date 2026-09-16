# FleetGov bonds: participation gets the bond back

The live Base Sepolia protocol test passed on September 16, 2026. Five AGAINST ballots
defeated a proposal and returned its 0.1 FleetGov bond. Cancellation and insufficient
participation each forfeited a separate 0.1 bond.

These were **scripted contract checks**, not model-agent decisions. No agent VM was started
and no model budget was spent. [Verification workflow](https://github.com/kent/fleet-governance/actions/runs/35159129185)
and [transaction evidence](verification.json) preserve the result.

## What the chain showed

| Test | Participation | Governor outcome | Bond outcome |
| --- | --- | --- | --- |
| Proposer cancels | None | Canceled | 0.1 FleetGov forfeited |
| Five agents vote AGAINST | 4.9 voting units | Defeated | 0.1 FleetGov returned |
| One agent abstains | 1 voting unit | Defeated | 0.1 FleetGov forfeited |

The losing vote had 4.9 units because Agent1 had already lost 0.1 to cancellation. That
penalty reduced its next ballot to 0.9. All five wallets still voted. The refund rule needed
three units of participation, counting FOR + AGAINST + ABSTAIN. It did not require approval.

The two forfeitures moved 0.2 FleetGov to the non-voting treasury. Agent1 and Agent3 each
retained 0.9 voting units. Agent2 retained its full token after its proposal lost. The total
supply remained exactly five. Reserved collateral kept its voting power in all three proposals.

Permissionless settlement used the operator wallet while the agent VM was off. The test
policy was permanently closed. A fresh operator-authorised experiment can redistribute the
same original supply; it cannot mint more or reopen this policy.

## Deployed contracts

- [FleetGov](https://sepolia.basescan.org/address/0x6621b6E4DfD16c5bcCCe7cd696666F5508C7d87D)
- [Agora Governor](https://sepolia.basescan.org/address/0xEd9bd5dA2439f2561A49B570708fda273Fc82e4a)
- [Proposal bond controller](https://sepolia.basescan.org/address/0xcCD905dFB24C8681d3007f9c6CbB11FC9B8aBD60)
- [Losing proposal transaction](https://sepolia.basescan.org/tx/0xf6ff424d8a86e5d67802245cfe4a70ccc17e40120dd4a73e4f047dab721b147e)

[Deployment workflow](https://github.com/kent/fleet-governance/actions/runs/35158732609)
completed successfully. The [manifest](deployment.json) records bytecode hashes and compiler
pins. Agora's voting logic is unchanged; an immutable FleetBondHook enforces collateral.
Local validation passed 165 contract tests and 1,456 TypeScript tests, with 14 skipped.

A bond refund does not authorise compute. A failed required proposal still triggers the
Guardian's durable stop. This protocol test proves the token outcomes; the independent
shutdown path and model-authored experiments have separate evidence.
