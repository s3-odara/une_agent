// Formal model of the Call lifecycle & half-duplex turn protocol:
//   gateway/src/call.rs (CallMachine, Calls, Player, watch_memberships) <-> src/call.ts (Calls)
//
// Models a single room with:
//   - User joining/leaving the Matrix room call (watch_memberships -> CallMachine in gateway)
//   - Async IPC channels between Rust (gateway) and Node (Calls): callLeft, callSpeak, callSpoken
//   - Utterance playback: writeFile -> callSpeak -> callSpoken
//   - Interruption via callLeft
module call_protocol {
  // --- World / Matrix room state ---
  var userInCall: bool          // Ground truth: allowed user is currently in the Matrix call

  // --- Gateway state (gateway/src/call.rs) ---
  var gwWanted: bool            // CallMachine.wanted (last observed by watch_memberships)
  var gwCallState: str          // "none" | "joining" | "inCall" | "leaving"
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

  // --- Bug-detection flag ---
  var playHungOnDeadRoom: bool

  pure def isQuiescent(
    evLeft: int, evSpk: Set[int], cSpk: Set[int],
    gwState: str, pState: str, uIn: bool, gwWant: bool
  ): bool =
    evLeft == 0
    and evSpk.size() == 0
    and cSpk.size() == 0
    and (gwState == "none" or gwState == "inCall")
    and pState == "idle"
    and uIn == gwWant

  action init = all {
    userInCall' = false,
    gwWanted' = false,
    gwCallState' = "none",
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
    playHungOnDeadRoom' = false,
  }

  // 1. User enters or leaves the Matrix call.
  action userToggleCall(entering: bool): bool = all {
    userInCall != entering,
    userInCall' = entering,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
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
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 2. Gateway watch_memberships observes a membership change and calls CallMachine::set_wanted.
  action gwObserveMembers: bool = all {
    gwWanted != userInCall,
    gwWanted' = userInCall,
    if (userInCall and gwCallState == "none") all {
      gwCallState' = "joining",
      gwPlayQueue' = gwPlayQueue,
    } else if (not(userInCall) and gwCallState == "inCall") all {
      gwCallState' = "leaving",
      gwPlayQueue' = Set(),
    } else all {
      gwCallState' = gwCallState,
      gwPlayQueue' = gwPlayQueue,
    },
    userInCall' = userInCall,
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
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 3. Gateway finishes joining and calls CallMachine::on_joined.
  action gwFinishJoin: bool = all {
    gwCallState == "joining",
    gwCallState' = if (gwWanted) "inCall" else "leaving",
    userInCall' = userInCall,
    gwWanted' = gwWanted,
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
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 4. Gateway sees ParticipantLeft while inCall (everyone else left SFU).
  action gwSpontaneousLeave: bool = all {
    gwCallState == "inCall",
    not(userInCall),
    gwCallState' = "leaving",
    gwPlayQueue' = Set(),
    userInCall' = userInCall,
    gwWanted' = gwWanted,
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
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 5. Gateway finishes leaving, emits Event::CallLeft, and rejoins immediately if gwWanted.
  action gwFinishLeave: bool = all {
    gwCallState == "leaving",
    gwCallState' = if (gwWanted) "joining" else "none",
    evCallLeft' = evCallLeft + 1,
    userInCall' = userInCall,
    gwWanted' = gwWanted,
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
    playHungOnDeadRoom' = playHungOnDeadRoom,
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
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    nextAgRoomId' = nextAgRoomId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
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
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    agSpokenWaiters' = agSpokenWaiters,
    playHungOnDeadRoom' = playHungOnDeadRoom,
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
      playHungOnDeadRoom' = playHungOnDeadRoom,
    } else all {
      playState' = "waitingSpoken",
      playRoomGen' = playRoomGen,
      playClipId' = playClipId,
      agSpokenWaiters' = agSpokenWaiters.union(Set(playClipId)),
      cmdCallSpeak' = cmdCallSpeak.union(Set(playClipId)),
      playHungOnDeadRoom' = playHungOnDeadRoom,
    },
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
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
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
    evCallLeft' = evCallLeft,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 9. Gateway finishes playing clip and emits CallSpoken.
  action gwFinishPlay(cid: int): bool = all {
    gwPlayQueue.contains(cid),
    gwPlayQueue' = gwPlayQueue.exclude(Set(cid)),
    evCallSpoken' = evCallSpoken.union(Set(cid)),
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
    evCallLeft' = evCallLeft,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
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
    userInCall' = userInCall,
    gwWanted' = gwWanted,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallLeft' = evCallLeft,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    nextAgRoomId' = nextAgRoomId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  action step = any {
    userToggleCall(true),
    userToggleCall(false),
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

  val invPlayNeverHangs: bool = not(playHungOnDeadRoom)

  val invMembershipConverges: bool =
    isQuiescent(
      evCallLeft, evCallSpoken, cmdCallSpeak,
      gwCallState, playState, userInCall, gwWanted
    ) implies ((gwCallState == "inCall") == userInCall)

  val allInvariants: bool = invPlayNeverHangs and invMembershipConverges
}
