// Formal model of the Approval workflow:
//   src/approval.ts (Approvals.ask, #post, #decide, onReaction, onMessage, interrupt)
//   <-> src/hostdb.ts (approvals, approval_rules)
//   <-> Matrix (reactions non-persistent, commands persisted/replayed)
module approval {
  type ReqId = str

  type ApprovalRec = {
    createdOrder: int,
    promptSent: bool,       // prompt_event_id is set (user actually saw the prompt)
    decision: str,          // "none" | "approve" | "approve_always" | "reject"
    reason: str
  }

  type AskStep = {
    tag: str,               // "idle" | "posting" | "waiting"
    reqId: ReqId
  }

  pure val ASK_IDLE: AskStep = { tag: "idle", reqId: "" }
  pure val REQS: Set[ReqId] = Set("a1", "a2")

  // --- Persistent states (HostDb) ---
  var approvals: ReqId -> ApprovalRec
  var nextOrder: int
  var alwaysRule: bool      // approval_rules has this tool

  // --- Volatile states ---
  var askStep: AskStep
  var startedReqs: Set[ReqId]

  // --- Bug-detection history variables ---
  var approvedUnpostedOrphan: bool
  var lostAlwaysRule: bool

  action init = all {
    approvals' = Map(),
    nextOrder' = 1,
    alwaysRule' = false,
    askStep' = ASK_IDLE,
    startedReqs' = Set(),
    approvedUnpostedOrphan' = false,
    lostAlwaysRule' = false,
  }

  // 1a. ask(r): addApproval(r) into HostDb (decision = NULL, prompt_event_id = NULL).
  action askAdd(r: ReqId): bool = all {
    askStep.tag == "idle",
    not(startedReqs.contains(r)),
    not(alwaysRule),
    startedReqs' = startedReqs.union(Set(r)),
    approvals' = if (approvals.keys().contains(r)) approvals
      else approvals.put(r, { createdOrder: nextOrder, promptSent: false, decision: "none", reason: "" }),
    nextOrder' = nextOrder + 1,
    askStep' = { tag: "posting", reqId: r },
    alwaysRule' = alwaysRule,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 1b. #post(r) succeeds: notice sent and setApprovalPrompt(r, eventId) persisted.
  action askPostOk: bool = all {
    askStep.tag == "posting",
    val r = askStep.reqId
    val rec = approvals.get(r)
    all {
      approvals' = approvals.set(r, { ...rec, promptSent: true }),
      askStep' = { tag: "waiting", reqId: r },
    },
    nextOrder' = nextOrder,
    alwaysRule' = alwaysRule,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 1c. #post(r) fails (network error / send timeout): ask() throws.
  action askPostFail: bool = all {
    askStep.tag == "posting",
    askStep' = ASK_IDLE,
    approvals' = approvals,
    nextOrder' = nextOrder,
    alwaysRule' = alwaysRule,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 1d. Waiting ask(r) sees decision != "none" and returns.
  action askFinish: bool = all {
    askStep.tag == "waiting",
    approvals.get(askStep.reqId).decision != "none",
    askStep' = ASK_IDLE,
    approvals' = approvals,
    nextOrder' = nextOrder,
    alwaysRule' = alwaysRule,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 2. User sends !approve / !approve_always / !reject command.
  //    HostDb.undecidedApprovals filters `prompt_event_id IS NOT NULL`;
  //    HostDb.decideApproval updates approval_rules in the same SQLite transaction.
  action cmdDecide(dec: str): bool = all {
    val undecided = approvals.keys().filter(k =>
      approvals.get(k).decision == "none" and approvals.get(k).promptSent
    )
    all {
      undecided.size() > 0,
      nondet oldest = oneOf(undecided)
      all {
        undecided.forall(k => approvals.get(oldest).createdOrder <= approvals.get(k).createdOrder),
        val rec = approvals.get(oldest)
        all {
          approvals' = approvals.set(oldest, { ...rec, decision: dec, reason: "" }),
          alwaysRule' = (alwaysRule or dec == "approve_always"),
          approvedUnpostedOrphan' = (approvedUnpostedOrphan or not(rec.promptSent)),
        },
      },
    },
    nextOrder' = nextOrder,
    askStep' = askStep,
    startedReqs' = startedReqs,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 3. User reacts on a visible prompt (atomic decideApproval transaction).
  action reactDecide(r: ReqId, dec: str): bool = all {
    approvals.keys().contains(r),
    val rec = approvals.get(r)
    all {
      rec.promptSent,
      rec.decision == "none",
      approvals' = approvals.set(r, { ...rec, decision: dec, reason: "" }),
      alwaysRule' = (alwaysRule or dec == "approve_always"),
    },
    nextOrder' = nextOrder,
    askStep' = askStep,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 4. Timeout or interrupt rejects posted undecided requests.
  action interruptAll: bool = all {
    approvals.keys().exists(k => approvals.get(k).decision == "none" and approvals.get(k).promptSent),
    approvals' = approvals.keys().mapBy(k =>
      val rec = approvals.get(k)
      if (rec.decision == "none" and rec.promptSent) { ...rec, decision: "reject", reason: "message" } else rec
    ),
    nextOrder' = nextOrder,
    alwaysRule' = alwaysRule,
    askStep' = askStep,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
    lostAlwaysRule' = lostAlwaysRule,
  }

  // 5. Crash & restart.
  action crashAndRestart: bool = all {
    askStep' = ASK_IDLE,
    val anyAlways = approvals.keys().exists(k => approvals.get(k).decision == "approve_always")
    lostAlwaysRule' = (lostAlwaysRule or (anyAlways and not(alwaysRule))),
    approvals' = approvals,
    nextOrder' = nextOrder,
    alwaysRule' = alwaysRule,
    startedReqs' = startedReqs,
    approvedUnpostedOrphan' = approvedUnpostedOrphan,
  }

  action step = any {
    nondet r = oneOf(REQS)
    askAdd(r),
    askPostOk,
    askPostFail,
    askFinish,
    cmdDecide("approve"),
    cmdDecide("approve_always"),
    cmdDecide("reject"),
    nondet r = oneOf(REQS)
    reactDecide(r, "approve"),
    nondet r = oneOf(REQS)
    reactDecide(r, "approve_always"),
    interruptAll,
    crashAndRestart,
  }

  // === Invariants ===

  val invNoOrphanApprovalHit: bool = not(approvedUnpostedOrphan)
  val invAlwaysRuleAtomic: bool = not(lostAlwaysRule)

  val allInvariants: bool = invNoOrphanApprovalHit and invAlwaysRuleAtomic
}
