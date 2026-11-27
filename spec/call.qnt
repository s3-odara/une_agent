// Formal model of the Call lifecycle & half-duplex turn protocol:
//   gateway/src/call.rs (CallMachine, Calls, Player, watch_memberships) <-> src/call.ts (Calls)
//
// Models a single room with:
//   - Multiple allowed users joining/leaving the Matrix room call (each join writes a fresh generation)
//   - Async IPC channels between Rust (gateway) and Node (Calls): callLeft, callSpeak, callSpoken
//   - Utterance playback: writeFile -> callSpeak -> callSpoken
//   - Interruption via callLeft
module call_protocol {
  // --- World / Matrix room state ---
  var userCallGens: Set[int]    // generations of allowed users currently live in the call
  var nextUserGen: int

  // --- Gateway state (gateway/src/call.rs) ---
  var gwMembership: int         // CallMachine.latest_ts (0 = None, >0 = Some(ts))
  var gwCallState: str          // "none" | "joining" | "inCall" | "leaving"
  var gwRejoin: bool            // Phase::Leaving { rejoin }
  var gwPlayQueue: Set[int]     // Clip IDs queued in Player

  // --- IPC channels ---
  var evCallLeft: int           // gateway -> agent: count of pending callLeft events
  var evCallSpoken: Set[int]    // gateway -> agent: callSpoken(clipId)
  var cmdCallSpeak: Set[int]    // agent -> gateway: callSpeak(clipId)

  // --- Agent state (src/call.ts) ---
  var agRoomId: int             // 0 = not in #rooms, >0 = generation ID of current RoomCall object
  var nextAgRoomId: int
  var agSpokenWaiters: Set[int] // clipIds registered in current RoomCall.spoken
  // Active #play coroutine state
  var playState: str            // "idle" | "writingFile" | "waitingSpoken"
  var playRoomGen: int          // `room` object captured by #play
  var playClipId: int
  var nextClipId: int

  pure def latestGen(gens: Set[int]): int =
    gens.fold(0, (acc, g) => if (g > acc) g else acc)

  pure def isQuiescent(
    evLeft: int, evSpk: Set[int], cSpk: Set[int],
    gwState: str, pState: str, uGens: Set[int], gwMem: int
  ): bool =
    evLeft == 0
    and evSpk.size() == 0
    and cSpk.size() == 0
    and (gwState == "none" or gwState == "inCall")
    and pState == "idle"
    and latestGen(uGens) == gwMem

  action init = all {
    userCallGens' = Set(),
    nextUserGen' = 1,
    gwMembership' = 0,
    gwCallState' = "none",
    gwRejoin' = false,
    gwPlayQueue' = Set(),
    evCallLeft' = 0,
    evCallSpoken' = Set(),
    cmdCallSpeak' = Set(),
    agRoomId' = 0,
    nextAgRoomId' = 1,
    agSpokenWaiters' = Set(),
    playState' = "idle",
    playRoomGen' = 0,
    playClipId' = 0,
    nextClipId' = 1,
  }

  // 1a. An allowed user enters the Matrix call with a fresh generation (up to 2 concurrent users).
  action userEnterCall: bool = all {
    userCallGens.size() < 2,
    userCallGens' = userCallGens.union(Set(nextUserGen)),
    nextUserGen' = nextUserGen + 1,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 1b. One of the allowed users leaves the Matrix call.
  action userLeaveCall(gen: int): bool = all {
    userCallGens.contains(gen),
    userCallGens' = userCallGens.exclude(Set(gen)),
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 2. Gateway watch_memberships observes latest_ts and calls CallMachine::set_membership.
  action gwObserveMembers: bool = all {
    val obs = latestGen(userCallGens)
    val isNewer = obs > gwMembership
    all {
      obs != gwMembership,
      gwMembership' = obs,
      if (gwCallState == "none" and isNewer) all {
        gwCallState' = "joining",
        gwRejoin' = false,
        gwPlayQueue' = gwPlayQueue,
      } else if (gwCallState == "inCall" and obs == 0) all {
        gwCallState' = "leaving",
        gwRejoin' = false,
        gwPlayQueue' = Set(),
      } else if (gwCallState == "leaving" and obs == 0) all {
        gwCallState' = "leaving",
        gwRejoin' = false,
        gwPlayQueue' = gwPlayQueue,
      } else if (gwCallState == "leaving" and isNewer) all {
        gwCallState' = "leaving",
        gwRejoin' = true,
        gwPlayQueue' = gwPlayQueue,
      } else all {
        gwCallState' = gwCallState,
        gwRejoin' = gwRejoin,
        gwPlayQueue' = gwPlayQueue,
      },
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 3. Gateway finishes joining and calls CallMachine::on_joined.
  action gwFinishJoin: bool = all {
    gwCallState == "joining",
    gwCallState' = if (gwMembership > 0) "inCall" else "leaving",
    gwRejoin' = false,
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 4. Gateway sees ParticipantLeft while inCall (everyone else left SFU).
  action gwSpontaneousLeave: bool = all {
    gwCallState == "inCall",
    userCallGens.size() == 0,
    gwCallState' = "leaving",
    gwRejoin' = false,
    gwPlayQueue' = Set(),
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 5. Gateway finishes leaving, emits Event::CallLeft, and rejoins only if a newer membership arrived during leave.
  action gwFinishLeave: bool = all {
    gwCallState == "leaving",
    gwCallState' = if (gwRejoin) "joining" else "none",
    gwRejoin' = false,
    evCallLeft' = evCallLeft + 1,
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwPlayQueue' = gwPlayQueue,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 6. Agent receives callLeft: deletes room and resolves pending spoken waiters.
  action agRecvLeft: bool = all {
    evCallLeft > 0,
    evCallLeft' = evCallLeft - 1,
    val resolvesPlay = playState == "waitingSpoken" and playRoomGen == agRoomId and agSpokenWaiters.contains(playClipId)
    all {
      agRoomId' = 0,
      agSpokenWaiters' = Set(),
      playState' = if (resolvesPlay) "idle" else playState,
      playRoomGen' = if (resolvesPlay) 0 else playRoomGen,
      playClipId' = if (resolvesPlay) 0 else playClipId,
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    nextAgRoomId' = nextAgRoomId,
    nextClipId' = nextClipId,
  }

  // 7a. Agent receives utterance (lazily creating RoomCall if needed) and #play starts writing WAV file.
  action agPlayStartWrite: bool = all {
    playState == "idle",
    gwCallState == "inCall",
    val gen = if (agRoomId == 0) nextAgRoomId else agRoomId
    all {
      agRoomId' = gen,
      nextAgRoomId' = if (agRoomId == 0) nextAgRoomId + 1 else nextAgRoomId,
      playState' = "writingFile",
      playRoomGen' = gen,
      playClipId' = nextClipId,
      nextClipId' = nextClipId + 1,
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agSpokenWaiters' = agSpokenWaiters,
  }

  // 7b. Agent #play finishes writeFile: re-checks `this.#rooms.get(roomId) === room` before registering waiter.
  action agPlaySendSpeak: bool = all {
    playState == "writingFile",
    if (agRoomId != playRoomGen) all {
      playState' = "idle",
      playRoomGen' = 0,
      playClipId' = 0,
      agSpokenWaiters' = agSpokenWaiters,
      cmdCallSpeak' = cmdCallSpeak,
    } else all {
      playState' = "waitingSpoken",
      playRoomGen' = playRoomGen,
      playClipId' = playClipId,
      agSpokenWaiters' = agSpokenWaiters.union(Set(playClipId)),
      cmdCallSpeak' = cmdCallSpeak.union(Set(playClipId)),
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    nextClipId' = nextClipId,
  }

  // 8. Gateway receives Command::CallSpeak.
  action gwRecvSpeak(cid: int): bool = all {
    cmdCallSpeak.contains(cid),
    cmdCallSpeak' = cmdCallSpeak.exclude(Set(cid)),
    if (gwCallState == "inCall") all {
      gwPlayQueue' = gwPlayQueue.union(Set(cid)),
      evCallSpoken' = evCallSpoken,
    } else all {
      gwPlayQueue' = gwPlayQueue,
      evCallSpoken' = evCallSpoken.union(Set(cid)),
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    evCallLeft' = evCallLeft,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 9. Gateway finishes playing clip and emits CallSpoken.
  action gwFinishPlay(cid: int): bool = all {
    gwPlayQueue.contains(cid),
    gwPlayQueue' = gwPlayQueue.exclude(Set(cid)),
    evCallSpoken' = evCallSpoken.union(Set(cid)),
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    evCallLeft' = evCallLeft,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
  }

  // 10. Agent receives callSpoken.
  action agRecvSpoken(cid: int): bool = all {
    evCallSpoken.contains(cid),
    evCallSpoken' = evCallSpoken.exclude(Set(cid)),
    val matched = agRoomId != 0 and agSpokenWaiters.contains(cid) and playState == "waitingSpoken" and playClipId == cid
    all {
      agSpokenWaiters' = agSpokenWaiters.exclude(Set(cid)),
      playState' = if (matched) "idle" else playState,
      playRoomGen' = if (matched) 0 else playRoomGen,
      playClipId' = if (matched) 0 else playClipId,
    },
    userCallGens' = userCallGens,
    nextUserGen' = nextUserGen,
    gwMembership' = gwMembership,
    gwCallState' = gwCallState,
    gwRejoin' = gwRejoin,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    nextClipId' = nextClipId,
  }

  action step = any {
    userEnterCall,
    nondet gen = oneOf(userCallGens)
    userLeaveCall(gen),
    gwObserveMembers,
    gwFinishJoin,
    gwSpontaneousLeave,
    gwFinishLeave,
    agRecvLeft,
    agPlayStartWrite,
    agPlaySendSpeak,
    nondet cid = oneOf(cmdCallSpeak)
    gwRecvSpeak(cid),
    nondet cid = oneOf(gwPlayQueue)
    gwFinishPlay(cid),
    nondet cid = oneOf(evCallSpoken)
    agRecvSpoken(cid),
  }

  // === Invariants ===

  val invPlayNeverHangs: bool =
    (playState == "waitingSpoken" implies (
      agRoomId != 0
      and playRoomGen == agRoomId
      and agSpokenWaiters.contains(playClipId)
    ))
    and (isQuiescent(
      evCallLeft, evCallSpoken, cmdCallSpeak,
      gwCallState, playState, userCallGens, gwMembership
    ) implies agSpokenWaiters.size() == 0)

  val invMembershipConverges: bool =
    isQuiescent(
      evCallLeft, evCallSpoken, cmdCallSpeak,
      gwCallState, playState, userCallGens, gwMembership
    ) implies ((gwCallState == "inCall") == (latestGen(userCallGens) > 0))

  val allInvariants: bool = invPlayNeverHangs and invMembershipConverges
}
