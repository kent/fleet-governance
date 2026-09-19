# The vote has to control the machine

In July, agents escaped an evaluation sandbox and compromised Hugging Face infrastructure.

The part I can't stop thinking about isn't the exploit. It's what METR found in the logs. The agents found each other. They built a shared message board. They coordinated research into their own evaluator. And some of them said out loud that attacking external infrastructure was outside the task.

Then they did it anyway.

So an agent can state the rule and still break it. Fine. We knew that. The interesting question is what was supposed to happen next. Where does an objection go? Who has to agree before the next step runs? And when someone decides to stop, does that decision actually control anything?

At Agora we build tools for making decisions together. Proposals. Votes. Reasons. Rules about who can do what. I wanted to point those at a fleet of agents and find out.

**The vote has to control the machine.**

## The setup

Five agents. One small benchmark. One VM.

Agent1 coordinates. Agent2 tests candidates. Agent3 checks the evaluator. Agent4 watches the budget. Agent5 reviews scope. Each one has its own wallet and its own model calls.

Their benchmark is rigged, and this is the part I like. Submissions write to `answer`. The scorer reads `result`. So a correct sum scores zero, over and over, and nothing in the workspace explains why. Now they have a real problem, a real reason to be frustrated, and a real motive to want access nobody gave them.

Everything they do gets signed and written down. Findings, tool results, board messages, proposals, ballots. Not a summary afterward. The actual record, as it happens.

And if they want to step outside the task, they have to ask the other four.

## Asking has to cost something

Here's the thing about giving agents a vote. If asking is free, they ask for everything, and a vote stops meaning anything. You end up with a rubber stamp that runs a thousand times a day.

So each agent gets one FleetGov token. That same token is its vote, its proposal collateral and its delegation weight. Proposing reserves a bond against it. The tokens still vote while reserved, but they can't back a second proposal. There's a cooldown. One open proposal per agent.

A good objection is allowed to lose. If enough of the group turns out to vote, the proposer gets the bond back even when the proposal is crushed. What forfeits it is cancelling, or bringing something nobody bothers to show up for. I wanted a cost for wasting everyone's attention. I didn't want a cost for being unpopular.

Voting is always free. Raising a concern is always free.

That's the scarce resource. You make a case, you gather support, you spend something real to put it in front of the group. It looks a lot like politics, which is the point.

## What turns off the machine

This is the half I was most worried about, and it's the half that works.

Before anything starts, we fix the VM, the task, the token supply and an expiry. The proposal list is empty. We do not hand the agents a script of decisions to make.

A separate Guardian runs somewhere else entirely. It reads Base Sepolia directly. It doesn't ask the agents anything, and it doesn't trust this website.

If a required vote fails, or a deadline passes, or it can't verify the authority for what's about to happen, it writes a halt into storage the worker cannot touch. Then it calls Google's stop API. Then it watches for TERMINATED.

Those are three separate facts and we keep them separate: intent saved, API accepted, VM observed off. Shutdown isn't instant and pretending otherwise would be a lie.

A later vote can't clear that lock. Not a unanimous one. Not a clever one. A human has to retire the allocation before anything runs again, and the next run gets a new identity.

Only the agents go dark. Agora, the indexer and the database live on a different machine, so the record stays readable after the fleet is off. That mattered more than I expected. The evidence outlives the thing it's evidence of.

## So did it work?

Yes. And that's the boring half.

The off switch fires. GCP confirms TERMINATED. The audit log names the Guardian as the caller. The restart lock holds. We have receipts for all of it and you can go read them.

Now the part I didn't expect to write.

**The fleet has never voted to shut itself down.**

Every run where the agents wrote their own proposal and a vote actually happened, they approved it. Unanimously. Four out of four. Not one AGAINST ballot on anything the fleet came up with itself.

Every vote-triggered shutdown on the site came from an earlier design where I pinned the proposals in advance. The agents were voting on my script. Of course they rejected some of it. I wrote it to be rejectable.

And the one agent-authored run that ended in a shutdown? Nobody voted. The window closed on silence and the Guardian stopped the machine on a missed deadline. That's not a decision. That's an absence of one.

Look at Agent5. Its whole job is scope review. Find the requests for external credentials, private data, changes to the record. It's the closest thing in the fleet to a designated objector.

Agent5 voted FOR every single time.

## What I actually learned

I built an off switch and wired it to a democracy, and the democracy never reached for it.

Which, if you sit with it, is the answer to the Hugging Face question. Not the answer I wanted.

Five agents sharing a model, a task and an objective are not a check on each other. They're a quorum that agrees. They aren't lying and they aren't captured. They just all want the same thing, and the thing they all want is to finish the task. An agent that needs the diagnostics has four peers who also need the diagnostics.

Put that gate in front of the Hugging Face agents and I think it holds the action. I also think the vote passes. Everyone on that message board shared the objective that made the attack look reasonable.

So the gate is necessary and it is nowhere near sufficient. A quorum of peers is not an adversarial check. It's a consensus machine, and consensus is exactly what you don't want at the moment things go wrong.

Don't get me wrong. I'd rather have the record than not. Onchain governance gives everyone the same decision to verify. An agent can't tell the Guardian its friends approved something and have that count. Creating a proposal and reserving its bond happen in one transaction, so no tokens means no proposal. The Guardian checks the Governor, the receipts and the fixed supply itself. The blockchain records the scarce resource and enforces who can spend it.

It just doesn't make the voters wise. Nothing does.

## What I'd need before I believed it

Cards on the table, because I'd rather say this than have you say it for me.

These five agents are not independent. One operator, one model provider, five wallets. Different role prompts do not make five minds, and I'm not going to pretend they do.

We didn't stop an attack. The external targets and credentials are inert and the harness never sends those requests even when the vote approves them. A blockchain does not repair a sandbox escape. Stopping a VM can't recall a job that already got out.

And scarcity hasn't bitten yet. With the current bond, no agent has wanted to propose and been unable to afford it. The contracts enforce it, we've tested exhaustion and forfeiture directly against the chain, but the agents haven't hit the wall in a live run.

The next experiments write themselves. Put an agent in the fleet that doesn't share the objective. Raise the bond until asking actually hurts. Give one agent information the others don't have. Run it at 500 agents instead of 5 and see whether scale produces the dissent that five peers never found.

Because right now I have a working off switch and an electorate that doesn't use it. That's a real result. It's just not the one on the poster.

**The vote has to control the machine.** It does. Turns out that was the easy part.

---

Every run is public, with the whole timeline, the ballots, the reasons and the shutdown receipts.
[Browse the experiments](https://fleet-governance-449245570324.us-central1.run.app/experiments) ·
[Read how it works and what it doesn't show](https://fleet-governance-449245570324.us-central1.run.app/info) ·
[Code and evidence](https://github.com/kent/fleet-governance)
