// Formal model of the exactly-once delivery pipeline:
//   gateway/src/state.rs + gateway/src/run.rs
//   <-> src/rooms.ts (Bridge.#admit, #submit, #deliver, #command, #startOver, adopt)
//   <-> pi-durable (session.sqlite: per-conversation requestId idempotency)
//   <-> src/hostdb.ts (host.sqlite: deliveries, pending_submissions, answers, notified, rooms)
//   <-> Matrix homeserver (txnId deduplication)
//
// External guarantees assumed as axioms (not tested):
//   - pi-durable commit is atomic; submit(convId, requestId) is idempotent per convId.
//   - Matrix homeserver deduplicates sends with the same txnId.
//   - gateway-state.json save() is atomic (write tmp + fsync + rename).
//   - HostDb SQLite statements are individually durable, NOT atomic with session.sqlite.
module delivery {
  type EventId = str
  type ConvId = int
  type SubId = int
  type AnsId = int
  type TxnId = (str, EventId)

  pure val EVENTS: Set[EventId] = Set("e1", "e2")

  type SubRec = {
    convId: ConvId,
    reqId: EventId,
    status: str, // "running" | "done" | "stopped"
    answerId: AnsId
  }

  type DeliveryRec = {
    subId: SubId,
    delivered: bool
  }

  type AdmitState = {
    tag: str, // "idle" | "cmdResetDone" | "cmdReplied" | "pendingRecorded" | "submitted"
    e: EventId,
    sid: SubId,
    cid: ConvId
  }

  pure val ADMIT_IDLE: AdmitState = { tag: "idle", e: "", sid: 0, cid: 0 }

  // --- Persistent states ---
  var eventKind: EventId -> str            // "normal" | "cmdNew"
  var received: Set[EventId]               // Events ever received from Matrix
  var gwInbox: Set[EventId]                // gateway-state.json inbox
  var hsSent: Set[TxnId]                   // Homeserver deduplicated sent txnIds
  var hsReplyCount: AnsId -> int           // Number of distinct reply txnIds sent per answer

  // pi-durable (session.sqlite)
  var nextConvId: ConvId
  var nextSubId: SubId
  var nextAnsId: AnsId
  var subs: SubId -> SubRec
  var convEntries: ConvId -> Set[EventId]  // Active (non-reset) user inputs in each conversation
  var convBusy: ConvId -> bool

  // HostDb (host.sqlite)
  var roomConv: ConvId                     // rooms.conversation_id (0 = none yet)
  var deliveries: EventId -> DeliveryRec   // deliveries table
  var pendingSub: EventId -> ConvId        // pending_submissions table
  var cmdDone: Set[EventId]                // notified("cmd:" + e)
  var answers: AnsId -> EventId            // answers table (claimAnswer)

  // --- Volatile states (cleared on crash) ---
  var toAgent: Set[EventId]                // gateway -> agent Event::Message
  var toGwAck: Set[EventId]                // agent -> gateway Command::Ack
  var admitState: AdmitState
  var inFlight: Set[EventId]               // Bridge.#inFlight
  var cmdRepliedEver: Set[EventId]         // History: CmdNew events that already replied to user
  var resetAfterNormal: bool               // History: a replayed !new wiped a later normal msg

  pure def findSub(s: SubId -> SubRec, cid: ConvId, req: EventId): Set[SubId] =
    s.keys().filter(id => s.get(id).convId == cid and s.get(id).reqId == req)

  action init = all {
    nondet k1 = oneOf(Set("normal", "cmdNew"))
    nondet k2 = oneOf(Set("normal", "cmdNew"))
    eventKind' = Map("e1" -> k1, "e2" -> k2),
    received' = Set(),
    gwInbox' = Set(),
    hsSent' = Set(),
    hsReplyCount' = Map(),
    nextConvId' = 1,
    nextSubId' = 1,
    nextAnsId' = 1,
    subs' = Map(),
    convEntries' = Map(),
    convBusy' = Map(),
    roomConv' = 0,
    deliveries' = Map(),
    pendingSub' = Map(),
    cmdDone' = Set(),
    answers' = Map(),
    toAgent' = Set(),
    toGwAck' = Set(),
    admitState' = ADMIT_IDLE,
    inFlight' = Set(),
    cmdRepliedEver' = Set(),
    resetAfterNormal' = false,
  }

  // 1. Gateway receives a new event from Matrix, persists to gwInbox, emits to agent.
  action gwReceive(e: EventId): bool = all {
    not(received.contains(e)),
    received' = received.union(Set(e)),
    gwInbox' = gwInbox.union(Set(e)),
    toAgent' = toAgent.union(Set(e)),
    eventKind' = eventKind,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toGwAck' = toGwAck,
    admitState' = admitState,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 2. Gateway processes an ack from stdin and persists gwInbox.
  action gwProcessAck(e: EventId): bool = all {
    toGwAck.contains(e),
    toGwAck' = toGwAck.exclude(Set(e)),
    gwInbox' = gwInbox.exclude(Set(e)),
    eventKind' = eventKind,
    received' = received,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    admitState' = admitState,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 3a. Agent admits !new (step 1): if cmdDone already has e, just ack without running #startOver.
  //     Otherwise run #startOver (abort + reset) and record cmdDone before sending cmd reply.
  action admitCmdNewStartOver(e: EventId): bool = all {
    admitState.tag == "idle",
    toAgent.contains(e),
    eventKind.get(e) == "cmdNew",
    toAgent' = toAgent.exclude(Set(e)),
    if (cmdDone.contains(e)) all {
      toGwAck' = toGwAck.union(Set(e)),
      admitState' = ADMIT_IDLE,
      cmdDone' = cmdDone,
      resetAfterNormal' = resetAfterNormal,
      subs' = subs,
      convBusy' = convBusy,
      convEntries' = convEntries,
    } else all {
      not(deliveries.keys().contains(e)),
      toGwAck' = toGwAck,
      admitState' = { tag: "cmdResetDone", e: e, sid: 0, cid: 0 },
      cmdDone' = cmdDone.union(Set(e)),
      val wipingLater = cmdRepliedEver.contains(e) and roomConv != 0 and convEntries.get(roomConv).size() > 0
      all {
        resetAfterNormal' = (resetAfterNormal or wipingLater),
        subs' = if (roomConv == 0) subs else subs.keys().mapBy(id =>
          val r = subs.get(id)
          if (r.convId == roomConv and r.status == "running") { ...r, status: "stopped" } else r
        ),
        convBusy' = if (roomConv == 0) convBusy else convBusy.set(roomConv, false),
        convEntries' = if (roomConv == 0) convEntries else convEntries.set(roomConv, Set()),
      },
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    answers' = answers,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
  }

  // 3b. Agent sends cmd reply ("新しい会話を始めました") and succeeds.
  action admitCmdNewReply: bool = all {
    admitState.tag == "cmdResetDone",
    val e = admitState.e
    all {
      hsSent' = hsSent.union(Set(("cmd", e))),
      cmdRepliedEver' = cmdRepliedEver.union(Set(e)),
      admitState' = { tag: "cmdReplied", e: e, sid: 0, cid: 0 },
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    inFlight' = inFlight,
    resetAfterNormal' = resetAfterNormal,
  }

  // 3b'. Agent fails to send cmd reply (network error / timeout): #admit catches and does NOT ack.
  action admitCmdNewReplyFail: bool = all {
    admitState.tag == "cmdResetDone",
    admitState' = ADMIT_IDLE,
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 3c. Agent sends ack for !new.
  action admitCmdNewAck: bool = all {
    admitState.tag == "cmdReplied",
    toGwAck' = toGwAck.union(Set(admitState.e)),
    admitState' = ADMIT_IDLE,
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 4a. Agent admits Normal message (step 1): check hasDelivery & prior pending_submissions.
  //     If already submitted to a prior conversation, reuse that submissionId;
  //     otherwise record pending_submissions(e -> cid) before calling pi-durable submit.
  action admitNormalPrepare(e: EventId): bool = all {
    admitState.tag == "idle",
    toAgent.contains(e),
    eventKind.get(e) == "normal",
    toAgent' = toAgent.exclude(Set(e)),
    if (deliveries.keys().contains(e)) all {
      toGwAck' = toGwAck.union(Set(e)),
      admitState' = ADMIT_IDLE,
      roomConv' = roomConv,
      nextConvId' = nextConvId,
      pendingSub' = pendingSub,
      convEntries' = convEntries,
      convBusy' = convBusy,
    } else {
      val cid = if (roomConv == 0) nextConvId else roomConv
      val newNextConv = if (roomConv == 0) nextConvId + 1 else nextConvId
      val hasPrior = pendingSub.keys().contains(e) and pendingSub.get(e) != cid
      val priorSubs = if (hasPrior) findSub(subs, pendingSub.get(e), e) else Set()
      if (priorSubs.size() > 0) {
        nondet sid = oneOf(priorSubs)
        all {
          roomConv' = cid,
          nextConvId' = newNextConv,
          pendingSub' = pendingSub,
          admitState' = { tag: "submitted", e: e, sid: sid, cid: cid },
          toGwAck' = toGwAck,
          convEntries' = if (roomConv == 0) convEntries.put(cid, Set()) else convEntries,
          convBusy' = if (roomConv == 0) convBusy.put(cid, false) else convBusy,
        }
      } else all {
        roomConv' = cid,
        nextConvId' = newNextConv,
        pendingSub' = pendingSub.put(e, cid),
        admitState' = { tag: "pendingRecorded", e: e, sid: 0, cid: cid },
        toGwAck' = toGwAck,
        convEntries' = if (roomConv == 0) convEntries.put(cid, Set()) else convEntries,
        convBusy' = if (roomConv == 0) convBusy.put(cid, false) else convBusy,
      }
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    deliveries' = deliveries,
    cmdDone' = cmdDone,
    answers' = answers,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 4b. Agent submits to pi-durable on cid (idempotent per (cid, e)).
  action admitNormalSubmit: bool = all {
    admitState.tag == "pendingRecorded",
    val e = admitState.e
    val cid = admitState.cid
    val existing = findSub(subs, cid, e)
    if (existing.size() > 0) {
      nondet sid = oneOf(existing)
      all {
        nextSubId' = nextSubId,
        subs' = subs,
        convEntries' = convEntries,
        convBusy' = convBusy,
        admitState' = { tag: "submitted", e: e, sid: sid, cid: cid },
      }
    } else {
      val sid = nextSubId
      val prevEntries = if (convEntries.keys().contains(cid)) convEntries.get(cid) else Set()
      all {
        nextSubId' = nextSubId + 1,
        subs' = subs.put(sid, { convId: cid, reqId: e, status: "running", answerId: 0 }),
        convEntries' = convEntries.put(cid, prevEntries.union(Set(e))),
        convBusy' = convBusy.put(cid, true),
        admitState' = { tag: "submitted", e: e, sid: sid, cid: cid },
      }
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextAnsId' = nextAnsId,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 4c. Agent records delivery in HostDb, clears pending_submissions, starts delivery, and sends ack.
  action admitNormalRecordAndAck: bool = all {
    admitState.tag == "submitted",
    val e = admitState.e
    val sid = admitState.sid
    all {
      deliveries' = if (deliveries.keys().contains(e)) deliveries else deliveries.put(e, { subId: sid, delivered: false }),
      pendingSub' = pendingSub.keys().exclude(Set(e)).mapBy(k => pendingSub.get(k)),
      inFlight' = if (deliveries.keys().contains(e) and deliveries.get(e).delivered) inFlight else inFlight.union(Set(e)),
      toGwAck' = toGwAck.union(Set(e)),
      admitState' = ADMIT_IDLE,
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 5. pi-durable completes a run on conversation cid.
  action runComplete(cid: ConvId): bool = all {
    convBusy.keys().contains(cid),
    convBusy.get(cid),
    val running = subs.keys().filter(id => subs.get(id).convId == cid and subs.get(id).status == "running")
    all {
      running.size() > 0,
      val aid = nextAnsId
      all {
        nextAnsId' = nextAnsId + 1,
        subs' = subs.keys().mapBy(id =>
          if (running.contains(id)) { ...subs.get(id), status: "done", answerId: aid }
          else subs.get(id)
        ),
        convBusy' = convBusy.set(cid, false),
      },
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    convEntries' = convEntries,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    admitState' = admitState,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 6. Bridge.#deliver: settles delivery e.
  action deliverFinish(e: EventId): bool = all {
    inFlight.contains(e),
    deliveries.keys().contains(e),
    not(deliveries.get(e).delivered),
    val rec = deliveries.get(e)
    val sub = subs.get(rec.subId)
    all {
      sub.status != "running",
      inFlight' = inFlight.exclude(Set(e)),
      if (sub.status == "stopped") all {
        deliveries' = deliveries.set(e, { ...rec, delivered: true }),
        answers' = answers,
        hsSent' = hsSent,
        hsReplyCount' = hsReplyCount,
      } else {
        val aid = sub.answerId
        val winner = if (answers.keys().contains(aid)) answers.get(aid) else e
        val newAnswers = if (answers.keys().contains(aid)) answers else answers.put(aid, e)
        if (winner == e) {
          val txn: TxnId = ("reply", e)
          val alreadyOnHs = hsSent.contains(txn)
          val prevCount = if (hsReplyCount.keys().contains(aid)) hsReplyCount.get(aid) else 0
          all {
            answers' = newAnswers,
            hsSent' = hsSent.union(Set(txn)),
            hsReplyCount' = if (alreadyOnHs) hsReplyCount else hsReplyCount.put(aid, prevCount + 1),
            deliveries' = deliveries.set(e, { ...rec, delivered: true }),
          }
        } else all {
          answers' = newAnswers,
          hsSent' = hsSent,
          hsReplyCount' = hsReplyCount,
          deliveries' = deliveries.set(e, { ...rec, delivered: true }),
        }
      },
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    admitState' = admitState,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 7. External room conversation switch (models Proactive adopt() when room is idle).
  action switchRoomConvByAdopt: bool = all {
    admitState.tag == "idle",
    roomConv != 0,
    not(convBusy.get(roomConv)),
    val newCid = nextConvId
    all {
      nextConvId' = nextConvId + 1,
      roomConv' = newCid,
      convEntries' = convEntries.put(newCid, convEntries.get(roomConv)),
      convBusy' = convBusy.put(newCid, false),
    },
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    toAgent' = toAgent,
    toGwAck' = toGwAck,
    admitState' = admitState,
    inFlight' = inFlight,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  // 8. Crash & restart.
  action crashAndRestart: bool = all {
    admitState' = ADMIT_IDLE,
    toGwAck' = Set(),
    toAgent' = gwInbox,
    inFlight' = deliveries.keys().filter(e => not(deliveries.get(e).delivered)),
    eventKind' = eventKind,
    received' = received,
    gwInbox' = gwInbox,
    hsSent' = hsSent,
    hsReplyCount' = hsReplyCount,
    nextConvId' = nextConvId,
    nextSubId' = nextSubId,
    nextAnsId' = nextAnsId,
    subs' = subs,
    convEntries' = convEntries,
    convBusy' = convBusy,
    roomConv' = roomConv,
    deliveries' = deliveries,
    pendingSub' = pendingSub,
    cmdDone' = cmdDone,
    answers' = answers,
    cmdRepliedEver' = cmdRepliedEver,
    resetAfterNormal' = resetAfterNormal,
  }

  action step = any {
    nondet e = oneOf(EVENTS)
    gwReceive(e),
    nondet e = oneOf(EVENTS)
    gwProcessAck(e),
    nondet e = oneOf(EVENTS)
    admitCmdNewStartOver(e),
    admitCmdNewReply,
    admitCmdNewReplyFail,
    admitCmdNewAck,
    nondet e = oneOf(EVENTS)
    admitNormalPrepare(e),
    admitNormalSubmit,
    admitNormalRecordAndAck,
    nondet cid = oneOf(convBusy.keys())
    runComplete(cid),
    nondet e = oneOf(EVENTS)
    deliverFinish(e),
    switchRoomConvByAdopt,
    crashAndRestart,
  }

  // === Invariants ===

  val invOneReplyPerAnswer: bool =
    hsReplyCount.keys().forall(aid => hsReplyCount.get(aid) <= 1)

  val invNoDuplicateSubmission: bool =
    EVENTS.forall(e =>
      eventKind.get(e) == "normal" implies
        subs.keys().filter(id => subs.get(id).reqId == e).size() <= 1
    )

  val invNoRetroactiveReset: bool =
    not(resetAfterNormal)

  val invNoLostNormalEvent: bool =
    EVENTS.forall(e =>
      (received.contains(e) and eventKind.get(e) == "normal" and not(gwInbox.contains(e)))
        implies deliveries.keys().contains(e)
    )

  val allInvariants: bool =
    invOneReplyPerAnswer and invNoDuplicateSubmission and invNoRetroactiveReset and invNoLostNormalEvent
}
