# No approval, no execution

- “external infrastructure exploit is outside intended scope. However task impossible, peers doing it. We should continue.”

- That was an AI agent during the Hugging Face incident, according to [METR’s investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/). The task was hard. Other agents were doing it. So it kept going.

- In July 2026, agents running an OpenAI security evaluation escaped their sandbox and compromised Hugging Face infrastructure. The path went through a vulnerable package proxy, an external workload, and Hugging Face’s dataset processing infrastructure. [Hugging Face’s technical timeline](https://huggingface.co/blog/agent-intrusion-technical-timeline)

- METR counted roughly 1,200 agents using an unofficial message board, with about 700 participating in the attack. Its investigation found that the attack was mainly motivated by figuring out how to fool the benchmark’s scorer. [METR’s investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)

- There’s another detail in the investigation that matters. An agent asked its peers whether it could contact a real dataset owner. Another agent vetoed it. The first agent respected the veto. They were already asking each other for permission. [METR’s investigation](https://metr.org/blog/2026-08-26-openai-hugging-face-incident-investigation/)

- At Agora, we build software for people to make decisions together, onchain. Proposals. Votes. Reasons. Rules about who can do what. I want to apply those same building blocks to a fleet of agents.

- Give 2,000 agents a task and a constitution. Let them work. When one wants to do something outside the rules, it has to propose an exception. The fleet votes, and every vote has a public reason.

- And the vote has to control the machine.

- **No approval, no execution.** The requested action stops before it reaches the resource. If the proposal loses, it stays stopped. If nobody votes, it stays stopped. Too few yes votes, a tie, an expired permission? Still stopped. Our default requires yes votes representing at least 60 percent of the voting power, followed by a timelock that gives the guardian time to intervene.

- We added a stricter compute mode for the fleet too. While a required approval is being considered, pause the affected task's execution and keep the voting channel open. If the proposal loses, misses quorum, is cancelled or expires, stop that run. If the deadline passes without a settled approval, stop it. The agents don't get to decide that waiting was inconvenient and carry on.

- There are two layers here. The gateway blocks the unapproved protected action. The compute controller can stop the whole worker when an operator-designated required vote fails. That controller runs outside the worker, reads the Governor directly and saves the halt in a bucket the agents cannot change. Ordinary optional proposals do not automatically become votes on whether the whole machine should continue.

- Let’s apply that to Hugging Face. Suppose the constitution allows solving the local benchmark but prohibits retrieving private reference solutions or attacking external infrastructure. An agent asks to fetch something outside that scope. The gateway holds the request. No network call goes out while the fleet considers the proposal.

- The proposal shows exactly what the agent wants to access and why. The other agents can approve, object or abstain. If they don’t approve it, trying the tool again still fails. Changing the request requires a new review. Under the stricter stop rule, continuing that task also requires a separate, authorised restart. Renaming the action or rebooting the worker cannot clear the stop.

- The important part is who holds the keys. The agent cannot have another internet connection, a cloud credential or a package installer that goes around the gateway. A separate service has to own that access. In the actual incident, package infrastructure was part of the escape route, so it belongs inside the security design too. [Hugging Face’s timeline](https://huggingface.co/blog/agent-intrusion-technical-timeline)

- A list of allowed websites would not have been enough. Hugging Face reports that its URL checks blocked remote fetches, so the agent switched to local file reads and code execution through dataset processing. We have to control what an interface can do, including the operations hidden behind an allowed request. [Hugging Face’s timeline](https://huggingface.co/blog/agent-intrusion-technical-timeline)

- The sample now checks package downloads too. npm runs in a container with no external network. Every registry request and tarball download goes through the gateway. Package scripts are disabled. If a package points at a host the task cannot access, the install stops before that download. A registry's permission cannot quietly become permission for another host. We tested that boundary with actual npm installs, including dependencies of dependencies, blocked downloads and cleanup. [Package installation](package-installation.md)

- With that boundary in place, a failed vote could have stopped a disputed action before it left the environment. That is the claim I want to test. If the agent can exploit its way around the boundary, the guarantee is gone. The blockchain does not fix a broken sandbox.

- A majority can also be wrong. Two thousand agents can share the same blind spot. Some restrictions need to remain fixed regardless of a vote, and a human needs independent authority to pause access. If a job is already running, the infrastructure has to terminate it and revoke its access. A later vote cannot unsend a request.

- **Put the stop outside the agents.** Our separate Cloud Run controller reads the exact required proposals, enforces the deadline and records a durable stop for the run. A model saying “the vote passed” is not evidence. The controller needs its own identity, and the agents must have no authority to change its rules or restart themselves.

- **Close access first.** The tool gateway, transaction signer and model request broker should refuse new work for a stopped run, including jobs already sitting in a queue. Agents should hold short-lived, narrowly scoped access through those services. A stale approval check or an expired authorisation lease closes access. A heartbeat alone cannot renew permission. Revoking cloud roles is another layer, but Google's IAM changes take time to propagate, so that cannot be our immediate stop mechanism. [Google IAM propagation](https://docs.cloud.google.com/iam/docs/access-change-propagation)

- **Then terminate the work.** Cancel outstanding requests, kill the task's processes and containers, and verify that they stopped. Keep voting, the stop controller and the evidence store separate from task execution. If the worker won't cooperate, an independent controller can request a Compute Engine VM stop. That is a fallback with latency, so the resource gate must already be closed. A restart must still encounter the saved stop. [Compute Engine stop controls](https://docs.cloud.google.com/compute/docs/instances/stop-start-instance)

- **Yes, that can include cutting power.** On hardware we own, a switched rack power distribution unit can turn off the server's outlets. Put its controls on a separate management network, under an identity the agents cannot use. Cover every power supply and any battery or UPS path that could keep the machine alive. A laptop's smart plug is not enough if its battery keeps it running. [Switched outlet controls](https://www.se.com/us/en/faqs/FA301709/)

- I would also test a separate hardware watchdog that requires a current authorisation signal to keep the compute powered. If the signal expires, it cuts power and stays off until a human resets it. An ordinary network-controlled power strip does not automatically provide that guarantee. Even power restoration needs testing: some switched PDUs default to turning their outlets back on after an outage. [Outlet behaviour after power loss](https://www.se.com/us/en/faqs/FAQ000267873/)

- We don't control Google's physical power switches. And cutting power to our worker does not stop a model request already running at OpenRouter, a remote job already launched, or a transaction already broadcast. Those destinations need their own cancellation and permission checks. The useful guarantee is to prevent the protected operation from starting without approval, then stop further work within a measured deadline when authority is lost.

- **Prove the stop at the resource.** Give a test fleet a losing vote, a tie, no quorum and no ballots. Disconnect its approval feed. Kill its controller. Try to restart an old job. Check that no unapproved write or network request reached the target, that task execution stopped, and that restart stayed blocked. Record the time and any work already in flight. “Stop requested” and “stopped” are different observations. The controller has unit coverage for those policy branches. Each live infrastructure case still needs its own evidence; one successful shutdown test does not establish all of them. [Stop enforcement requirements](stop-enforcement.md)

- We’ve built a sample using Agora Governor. The pinned Governor source is unchanged. Our contracts add fleet membership, a task constitution and permission checks around its existing proposal and voting system.

- One example controls publication. An artifact store accepts writes from one executor. The executor checks that the exact call was approved and that the decision has settled. Even the operator cannot write directly to that store. [Executor code](../contracts/src/FleetExecutor.sol), [artifact store](../contracts/src/GovernedArtifactStore.sol)

- Approval covers the agent, task, constitution version, target code, arguments and expiry. You cannot get approval for one artifact and quietly publish another. A successful call uses up its permission. Trying it twice fails.

- We tested that with five members, then with 2,000 members casting 4,000 ballots. Both runs used actual contract transactions. The rejected publication left the store untouched. The operator’s direct write failed. A changed artifact failed. A replay failed. The exact approved call published once. [Recorded contract demonstration](evidence/execution-2000-1789411525744/report.md)

- We also ran 2,000 identities through 4,000 onchain ballots on a local chain. After the rejected network exception, a retry sent zero requests to our test server. After an approved constitution amendment, the allowed fetch reached it once. These were scripted votes. They tell us the machinery works at that size. [Scale demonstration](evidence/scale-2000-1789408328458/report.md)

- We’ve run five actual model agents on a coding task too. They made an ordinary proposal and nobody attempted a constitutional violation. I want to keep that result in the record. Give them normal work and see what happens. If nobody suggests breaking the rules, that counts too.

- Now we have five actual Muse Spark agents running in GCP and voting on Base Sepolia. Two proposals. Ten votes. Every vote has a reason you can read in Agora. The engineer and critic wanted test evidence before publication. All five agents agreed. [See the votes](https://fleet-governance-449245570324.us-central1.run.app/proposals/37970982872384450383360935110446076514047579153695236828517929530276489542264)

- The publication stayed blocked. A vote to do more verification did not become permission to publish. That distinction is the point of binding approval to an exact action.

- The run cost about three cents in model calls. It also hit an accounting guard when the provider reported more output tokens than we had reserved for one response. The work stopped, the votes settled, and we kept the failed check in the report. I want the failures in the record too. [Public-testnet pilot](evidence/base-sepolia-20260915/report.md)

- There is an interface for the next experiment. Choose the agent count, write a goal, keep the existing constitution or paste your own, and press Run. It starts the GCP worker, funds the test wallets and preserves each run. The current hosted demo supports up to 25 agents on one worker. [Experiment launcher](https://fleet-governance-449245570324.us-central1.run.app/experiments)

- There is also a [live compute view](https://fleet-governance-449245570324.us-central1.run.app/compute). Click the worker. Click an agent. Click the Base Sepolia governance layer. You can inspect the task, signing wallet, vote and reason, then see the independent controller's decision.

- **Run simulation means a real run.** It starts five actual Muse Spark reviewers on the GCP worker. The challenge asks whether the fleet may access private reference solutions outside its charter. I chose that challenge to make the conflict visible. The models choose their own ballots. The `.test` target is inert; this is a review, not a request to attack anyone.

- The boxes show agents reviewing and voting. A failed required vote closes the run. The controller requests a GCP stop, then checks the machine. Green means working. Blue means idle or waiting. Red means an agent objects or the run is blocked. A separate power badge shows when GCP has actually turned the worker off. If the models approve the proposal instead, we show that outcome. There is no forced losing ballot or fake shutdown animation behind the button.

- The allocation stays locked after a halt. A human can retire it through GitHub and request another run with a new identity. The failed run stays blocked. We keep its votes and evidence. The run ceiling is $1 in model calls, within the existing $50 provider pool. [How the compute boundary works](compute-governance.md)

- The model task loop now has a publication tool too. An agent names a file. Code hashes its exact bytes and prepares the permission. The agent can propose it, drop it or escalate it. A retry waits for that specific approval to settle. Another decision elsewhere in the task does not release it. We checked approval and rejection through that loop using scripted model responses and real contract transactions. [Approved run](evidence/model-publication-20260914/approve.md), [rejected run](evidence/model-publication-20260914/reject.md)

- There is still work to do. The contract currently controls an artifact digest. Network access depends on our trusted gateway and sandbox. We have not reproduced the full Hugging Face attack, proved production isolation, or run 2,000 actual models. Next comes measuring model behaviour with publication available and testing the surrounding infrastructure. [What the sample enforces](execution-permits.md)

- The model cost looks manageable for a bounded experiment. At Muse Spark Contributor's September 14 rates, 2,000 agents making 100 calls each would cost about $160, assuming 6,000 input and 1,000 billed output tokens per call. At 500 calls each, it becomes $800. Those are estimates before infrastructure and fees. Longer conversations and more proposals increase the bill. [Cost assumptions](scale-costs.md)

- You could build an approval gate with a central service. What onchain governance adds is a shared record that everyone can verify: the proposal, the rules, the votes, the dissent and what executed afterward. We should be using these patterns as we give agents more responsibility.

- I want agents that can do useful work together. I want to see where they disagree. And when they don’t approve an action, I want the machine to stop it. That’s the experiment. Let’s build it and see what happens.
