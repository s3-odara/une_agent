// Formal model of Proactive aside/adopt vs user messages, !new, and timers:
//   src/proactive.ts (Proactive.#weigh, beforeTool / isWeighing)
//   src/rooms.ts (Bridge.startAside, adopt, #admit, #startOver, runTimer, #submit)
//   src/scheduler.ts (Scheduler.#dueTimers)
//   src/hostdb.ts (wakes, rooms, timers, deliveries, pending_submissions, isWeighing)
module proactive {
  type ConvId = int

  type WeighState = {
    tag: str, // "idle" | "asideCreated" | "submitted" | "answered" | "adopted" | "said"
    asideCid: ConvId,
    fromConv: ConvId,
    fromEntry: int,
    wantsToSpeak: bool
  }

  pure val W_IDLE: WeighState = {
    tag: "idle",
    asideCid: 0,
    fromConv: 0,
    fromEntry: 0,
    wantsToSpeak: false
  }

  // --- Persistent states ---
  // pi-durable (session.sqlite)
  var nextConvId: ConvId
  var convEntry: ConvId -> int          // latest entryId (0 = empty)
  var convBusy: ConvId -> bool
  var convSubReqs: ConvId -> Set[str]   // requestIds submitted to each conv
  var asideDecision: ConvId -> str      // persisted result of wake:w1 per aside ("none"|"speak"|"silent")

  // HostDb (host.sqlite)
  var roomConv: ConvId                  // rooms.conversation_id (0 = none)
  var wakeOutcome: str                  // "open" | "sent" | "silent"
  var wakeAside: ConvId                 // 0 = none, else aside convId
  var wakeFromConv: ConvId
  var wakeFromEntry: int
  var timerFired: bool
  var timerDelivered: bool              // deliveries contains "timer:t1"
  var timerPendingConv: ConvId          // pending_submissions["timer:t1"] (0 = none)

  // Homeserver
  var wakeSayCount: int
  var hsTxns: Set[str]

  // --- Volatile states ---
  var weighState: WeighState
  var timerStep: str                    // "idle" | "pendingRecorded" | "submitted" | "deliveryRecorded"
  var timerTargetConv: ConvId
  var userSent: bool
  var newSent: bool

  // --- Bug-detection history variables ---
  var userBlockedByWeighing: bool
  var silentAdopted: bool
  var timerSubCount: int

  // Matches HostDb.isWeighing: open aside that has NOT been adopted into rooms.
  pure def isWeighing(cid: ConvId, outcome: str, asideCid: ConvId, currentRoomConv: ConvId): bool =
    outcome == "open" and asideCid != 0 and asideCid == cid and cid != currentRoomConv

  action init = all {
    nextConvId' = 1,
    convEntry' = Map(),
    convBusy' = Map(),
    convSubReqs' = Map(),
    asideDecision' = Map(),
    roomConv' = 0,
    wakeOutcome' = "open",
    wakeAside' = 0,
    wakeFromConv' = 0,
    wakeFromEntry' = 0,
    timerFired' = false,
    timerDelivered' = false,
    timerPendingConv' = 0,
    wakeSayCount' = 0,
    hsTxns' = Set(),
    weighState' = W_IDLE,
    timerStep' = "idle",
    timerTargetConv' = 0,
    userSent' = false,
    newSent' = false,
    userBlockedByWeighing' = false,
    silentAdopted' = false,
    timerSubCount' = 0,
  }

  // 1a. startAside (when wake.aside is undefined)
  action weighStartAside: bool = all {
    weighState.tag == "idle",
    wakeOutcome == "open",
    wakeAside == 0,
    val mainCid = if (roomConv == 0) nextConvId else roomConv
    val mainBusy = if (roomConv == 0) false else convBusy.get(mainCid)
    val mainEntry = if (roomConv == 0) 0 else convEntry.get(mainCid)
    all {
      not(mainBusy),
      val asideCid = if (roomConv == 0) nextConvId + 1 else nextConvId
      val newNext = asideCid + 1
      all {
        nextConvId' = newNext,
        roomConv' = mainCid,
        convEntry' =
          (if (roomConv == 0) convEntry.put(mainCid, 0) else convEntry).put(asideCid, mainEntry),
        convBusy' =
          (if (roomConv == 0) convBusy.put(mainCid, false) else convBusy).put(asideCid, false),
        convSubReqs' =
          (if (roomConv == 0) convSubReqs.put(mainCid, Set()) else convSubReqs).put(asideCid, Set()),
        asideDecision' = asideDecision.put(asideCid, "none"),
        weighState' = {
          tag: "asideCreated",
          asideCid: asideCid,
          fromConv: mainCid,
          fromEntry: mainEntry,
          wantsToSpeak: false
        },
      },
    },
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 1b. db.setAside(wake.key, aside) + submit wake prompt to aside conv
  action weighSaveAside: bool = all {
    weighState.tag == "asideCreated",
    val cid = weighState.asideCid
    all {
      wakeAside' = cid,
      wakeFromConv' = weighState.fromConv,
      wakeFromEntry' = weighState.fromEntry,
      weighState' = { ...weighState, tag: "submitted" },
      convEntry' = convEntry.set(cid, convEntry.get(cid) + 1),
      convBusy' = convBusy.set(cid, true),
      convSubReqs' = convSubReqs.set(cid, convSubReqs.get(cid).union(Set("wake:w1"))),
    },
    nextConvId' = nextConvId,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 1c. Resume weighing after crash when wake.aside is already persisted in HostDb
  action weighResumePersisted: bool = all {
    weighState.tag == "idle",
    wakeOutcome == "open",
    wakeAside != 0,
    val alreadySub = convSubReqs.get(wakeAside).contains("wake:w1")
    all {
      weighState' = {
        tag: "submitted",
        asideCid: wakeAside,
        fromConv: wakeFromConv,
        fromEntry: wakeFromEntry,
        wantsToSpeak: false
      },
      convEntry' = if (alreadySub) convEntry else convEntry.set(wakeAside, convEntry.get(wakeAside) + 1),
      convBusy' = if (alreadySub) convBusy else convBusy.set(wakeAside, true),
      convSubReqs' = convSubReqs.set(wakeAside, convSubReqs.get(wakeAside).union(Set("wake:w1"))),
    },
    nextConvId' = nextConvId,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 2. Aside run finishes: model decides to speak (true) or stay_silent (false).
  action weighAsideFinish(wants: bool): bool = all {
    weighState.tag == "submitted",
    val cid = weighState.asideCid
    val prev = asideDecision.get(cid)
    val chosen = if (wants) "speak" else "silent"
    all {
      prev == "none" or prev == chosen,
      asideDecision' = asideDecision.set(cid, chosen),
      convBusy' = convBusy.set(cid, false),
      weighState' = { ...weighState, tag: "answered", wantsToSpeak: wants },
    },
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convSubReqs' = convSubReqs,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 3a. Model stayed silent -> db.endWake("silent")
  action weighEndSilent: bool = all {
    weighState.tag == "answered",
    not(weighState.wantsToSpeak),
    wakeOutcome' = "silent",
    weighState' = W_IDLE,
    silentAdopted' = (silentAdopted or (roomConv == weighState.asideCid)),
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    timerSubCount' = timerSubCount,
  }

  // 3b. Model wants to speak -> rooms.adopt(roomId, aside)
  action weighAdopt: bool = all {
    weighState.tag == "answered",
    weighState.wantsToSpeak,
    val alreadyAdopted = roomConv == weighState.asideCid
    val canAdopt =
      roomConv == weighState.fromConv
      and not(convBusy.get(roomConv))
      and convEntry.get(roomConv) == weighState.fromEntry
    if (alreadyAdopted or canAdopt) all {
      roomConv' = weighState.asideCid,
      weighState' = { ...weighState, tag: "adopted" },
      wakeAside' = wakeAside,
      wakeFromConv' = wakeFromConv,
      wakeFromEntry' = wakeFromEntry,
    } else all {
      roomConv' = roomConv,
      weighState' = W_IDLE,
      wakeAside' = 0,
      wakeFromConv' = 0,
      wakeFromEntry' = 0,
    },
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    wakeOutcome' = wakeOutcome,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 4. rooms.say(roomId, "reply:wake:w1", text)
  action weighSay: bool = all {
    weighState.tag == "adopted",
    val txn = "reply:wake:w1"
    val isNew = not(hsTxns.contains(txn))
    all {
      hsTxns' = hsTxns.union(Set(txn)),
      wakeSayCount' = if (isNew) wakeSayCount + 1 else wakeSayCount,
      weighState' = { ...weighState, tag: "said" },
    },
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // 5. db.endWake(wake.key, "sent")
  action weighEndSent: bool = all {
    weighState.tag == "said",
    wakeOutcome' = "sent",
    weighState' = W_IDLE,
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // --- Competing room actions ---

  // A. User sends a message -> Bridge.#admit submits to roomConv and runs a tool.
  action userMessage: bool = all {
    not(userSent),
    userSent' = true,
    val cid = if (roomConv == 0) nextConvId else roomConv
    val newNext = if (roomConv == 0) nextConvId + 1 else nextConvId
    val prevEntry = if (roomConv == 0) 0 else convEntry.get(cid)
    val prevReqs = if (roomConv == 0) Set() else convSubReqs.get(cid)
    all {
      nextConvId' = newNext,
      roomConv' = cid,
      convEntry' = convEntry.put(cid, prevEntry + 1),
      convBusy' = convBusy.put(cid, true),
      convSubReqs' = convSubReqs.put(cid, prevReqs.union(Set("u1"))),
      userBlockedByWeighing' = (userBlockedByWeighing or isWeighing(cid, wakeOutcome, wakeAside, cid)),
    },
    asideDecision' = asideDecision,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    newSent' = newSent,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // B. User sends !new -> Bridge.#startOver (abort + reset on roomConv, advancing entryId).
  action userCmdNew: bool = all {
    not(newSent),
    newSent' = true,
    if (roomConv == 0) all {
      convEntry' = convEntry,
      convBusy' = convBusy,
    } else all {
      convEntry' = convEntry.set(roomConv, convEntry.get(roomConv) + 1),
      convBusy' = convBusy.set(roomConv, false),
    },
    nextConvId' = nextConvId,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // C1. Scheduler.#dueTimers -> Bridge.runTimer (step 1: hasDelivery & pending_submissions check)
  action timerPrepare: bool = all {
    timerStep == "idle",
    not(timerFired),
    if (timerDelivered) all {
      // Already in deliveries: skip submit, proceed to markTimerFired
      timerStep' = "deliveryRecorded",
      timerTargetConv' = 0,
      timerPendingConv' = timerPendingConv,
      nextConvId' = nextConvId,
      roomConv' = roomConv,
      convEntry' = convEntry,
      convBusy' = convBusy,
      convSubReqs' = convSubReqs,
    } else {
      val cid = if (roomConv == 0) nextConvId else roomConv
      val newNext = if (roomConv == 0) nextConvId + 1 else nextConvId
      val alreadyInPrior =
        timerPendingConv != 0 and timerPendingConv != cid and convSubReqs.get(timerPendingConv).contains("timer:t1")
      if (alreadyInPrior) all {
        timerStep' = "submitted",
        timerTargetConv' = timerPendingConv,
        timerPendingConv' = timerPendingConv,
        nextConvId' = newNext,
        roomConv' = cid,
        convEntry' = if (roomConv == 0) convEntry.put(cid, 0) else convEntry,
        convBusy' = if (roomConv == 0) convBusy.put(cid, false) else convBusy,
        convSubReqs' = if (roomConv == 0) convSubReqs.put(cid, Set()) else convSubReqs,
      } else all {
        timerStep' = "pendingRecorded",
        timerTargetConv' = cid,
        timerPendingConv' = cid,
        nextConvId' = newNext,
        roomConv' = cid,
        convEntry' = if (roomConv == 0) convEntry.put(cid, 0) else convEntry,
        convBusy' = if (roomConv == 0) convBusy.put(cid, false) else convBusy,
        convSubReqs' = if (roomConv == 0) convSubReqs.put(cid, Set()) else convSubReqs,
      }
    },
    asideDecision' = asideDecision,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // C2. Bridge.runTimer (step 2: pi-durable submit on timerTargetConv)
  action timerSubmit: bool = all {
    timerStep == "pendingRecorded",
    val cid = timerTargetConv
    val alreadySub = convSubReqs.get(cid).contains("timer:t1")
    all {
      convEntry' = if (alreadySub) convEntry else convEntry.set(cid, convEntry.get(cid) + 1),
      convBusy' = convBusy.set(cid, true),
      convSubReqs' = convSubReqs.set(cid, convSubReqs.get(cid).union(Set("timer:t1"))),
      timerSubCount' = if (alreadySub) timerSubCount else timerSubCount + 1,
      timerStep' = "submitted",
      userBlockedByWeighing' = (userBlockedByWeighing or isWeighing(cid, wakeOutcome, wakeAside, roomConv)),
    },
    nextConvId' = nextConvId,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    silentAdopted' = silentAdopted,
  }

  // C3. Bridge.runTimer (step 3: db.addDelivery + clearPendingSubmission)
  action timerRecordDelivery: bool = all {
    timerStep == "submitted",
    timerDelivered' = true,
    timerPendingConv' = 0,
    timerStep' = "deliveryRecorded",
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // C4. Scheduler marks timer fired
  action timerMarkFired: bool = all {
    timerStep == "deliveryRecorded",
    timerFired' = true,
    timerStep' = "idle",
    timerTargetConv' = 0,
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // D. Room conversation run finishes
  action roomRunFinish: bool = all {
    roomConv != 0,
    convBusy.get(roomConv),
    convBusy' = convBusy.set(roomConv, false),
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    weighState' = weighState,
    timerStep' = timerStep,
    timerTargetConv' = timerTargetConv,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  // E. Crash & restart: volatile weighState and timerStep reset to Idle; persistent DB remains.
  action crashAndRestart: bool = all {
    weighState' = W_IDLE,
    timerStep' = "idle",
    timerTargetConv' = 0,
    nextConvId' = nextConvId,
    convEntry' = convEntry,
    convBusy' = convBusy,
    convSubReqs' = convSubReqs,
    asideDecision' = asideDecision,
    roomConv' = roomConv,
    wakeOutcome' = wakeOutcome,
    wakeAside' = wakeAside,
    wakeFromConv' = wakeFromConv,
    wakeFromEntry' = wakeFromEntry,
    timerFired' = timerFired,
    timerDelivered' = timerDelivered,
    timerPendingConv' = timerPendingConv,
    wakeSayCount' = wakeSayCount,
    hsTxns' = hsTxns,
    userSent' = userSent,
    newSent' = newSent,
    userBlockedByWeighing' = userBlockedByWeighing,
    silentAdopted' = silentAdopted,
    timerSubCount' = timerSubCount,
  }

  action step = any {
    weighStartAside,
    weighSaveAside,
    weighResumePersisted,
    weighAsideFinish(true),
    weighAsideFinish(false),
    weighEndSilent,
    weighAdopt,
    weighSay,
    weighEndSent,
    userMessage,
    userCmdNew,
    timerPrepare,
    timerSubmit,
    timerRecordDelivery,
    timerMarkFired,
    roomRunFinish,
    crashAndRestart,
  }

  // === Invariants ===

  val invUserNeverBlockedByWeighing: bool = not(userBlockedByWeighing)
  val invSilentNeverAdopted: bool = not(silentAdopted)
  val invWakeSaysAtMostOnce: bool = wakeSayCount <= 1
  val invTimerRunsAtMostOnce: bool = timerSubCount <= 1

  val allInvariants: bool =
    invUserNeverBlockedByWeighing and invSilentNeverAdopted and invWakeSaysAtMostOnce and invTimerRunsAtMostOnce
}
