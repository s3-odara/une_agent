// Formal model of the Call lifecycle & half-duplex turn protocol:
//   src/call.ts (Calls) <-> gateway/src/call.rs (Calls, Player, watch_memberships)
//
// Models a single room with:
//   - User joining/leaving the Matrix room call (watch_memberships -> FIFO callMembers)
//   - Async IPC channels between Node (Calls) and Rust (gateway)
//   - Utterance handling: writeFile -> callSpeak -> callSpoken
//   - Interruption via callLeft
module call_protocol {
  // --- World / Matrix room state ---
  var userInCall: bool          // Ground truth: allowed user is currently in the Matrix call
  var gwKnownInCall: bool       // watch_memberships's last emitted state

  // --- Gateway state (gateway/src/call.rs) ---
  var gwCallState: str          // "none" | "joining" | "inCall" | "leaving"
  var gwPlayQueue: Set[int]     // Clip IDs queued in Player

  // --- IPC channels (gateway -> agent stdout is FIFO for callMembers) ---
  var evCallMembers: List[bool] // gateway -> agent: callMembers (non-empty?)
  var evCallJoined: bool        // gateway -> agent: callJoined
  var evCallLeft: int           // gateway -> agent: count of pending callLeft events
  var evCallSpoken: Set[int]    // gateway -> agent: callSpoken(clipId)

  var cmdJoinCall: bool         // agent -> gateway: joinCall
  var cmdLeaveCall: bool        // agent -> gateway: leaveCall
  var cmdCallSpeak: Set[int]    // agent -> gateway: callSpeak(clipId)

  // --- Agent state (src/call.ts) ---
  var agRoomId: int             // 0 = not in #rooms, >0 = generation ID of current RoomCall object
  var agWanted: bool            // #wanted.has(roomId)
  var nextAgRoomId: int
  var agJoined: bool
  var agSpokenWaiters: Set[int] // clipIds registered in current RoomCall.spoken
  // Active #play coroutine state
  var playState: str            // "idle" | "writingFile" | "waitingSpoken"
  var playRoomGen: int          // `room` object captured by #play
  var playClipId: int
  var nextClipId: int

  // --- Bug-detection flag ---
  var playHungOnDeadRoom: bool

  pure def isQuiescent(
    evMem: List[bool], evJoin: bool, evLeft: int, evSpk: Set[int],
    cJoin: bool, cLeave: bool, cSpk: Set[int],
    gwState: str, pState: str, uIn: bool, gwKnown: bool
  ): bool =
    evMem.length() == 0
    and not(evJoin)
    and evLeft == 0
    and evSpk.size() == 0
    and not(cJoin)
    and not(cLeave)
    and cSpk.size() == 0
    and (gwState == "none" or gwState == "inCall")
    and pState == "idle"
    and uIn == gwKnown

  action init = all {
    userInCall' = false,
    gwKnownInCall' = false,
    gwCallState' = "none",
    gwPlayQueue' = Set(),
    evCallMembers' = List(),
    evCallJoined' = false,
    evCallLeft' = 0,
    evCallSpoken' = Set(),
    cmdJoinCall' = false,
    cmdLeaveCall' = false,
    cmdCallSpeak' = Set(),
    agRoomId' = 0,
    agWanted' = false,
    nextAgRoomId' = 1,
    agJoined' = false,
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
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 2. Gateway watch_memberships observes a change and appends Event::CallMembers.
  action gwEmitMembers: bool = all {
    gwKnownInCall != userInCall,
    evCallMembers.length() < 4,
    gwKnownInCall' = userInCall,
    evCallMembers' = evCallMembers.append(userInCall),
    userInCall' = userInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 3. Agent receives callMembers in FIFO order (updated src/call.ts).
  action agRecvMembers: bool = all {
    evCallMembers.length() > 0,
    val hasMembers = evCallMembers.head()
    all {
      evCallMembers' = evCallMembers.tail(),
      agWanted' = hasMembers,
      if (hasMembers and agRoomId == 0) all {
        agRoomId' = nextAgRoomId,
        nextAgRoomId' = nextAgRoomId + 1,
        agJoined' = false,
        agSpokenWaiters' = Set(),
        cmdJoinCall' = true,
        cmdLeaveCall' = cmdLeaveCall,
      } else if (not(hasMembers) and agRoomId != 0) all {
        agRoomId' = agRoomId,
        nextAgRoomId' = nextAgRoomId,
        agJoined' = agJoined,
        agSpokenWaiters' = agSpokenWaiters,
        cmdJoinCall' = cmdJoinCall,
        cmdLeaveCall' = true,
      } else all {
        agRoomId' = agRoomId,
        nextAgRoomId' = nextAgRoomId,
        agJoined' = agJoined,
        agSpokenWaiters' = agSpokenWaiters,
        cmdJoinCall' = cmdJoinCall,
        cmdLeaveCall' = cmdLeaveCall,
      },
    },
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdCallSpeak' = cmdCallSpeak,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 4. Gateway receives Command::JoinCall.
  action gwRecvJoin: bool = all {
    cmdJoinCall,
    cmdJoinCall' = false,
    gwCallState' = if (gwCallState == "none") "joining" else gwCallState,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 5. Gateway finishes joining and emits Event::CallJoined.
  action gwFinishJoin: bool = all {
    gwCallState == "joining",
    gwCallState' = "inCall",
    evCallJoined' = true,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 6. Agent receives callJoined. If user already left (not agWanted), immediately send leaveCall.
  action agRecvJoined: bool = all {
    evCallJoined,
    evCallJoined' = false,
    agJoined' = if (agRoomId != 0) true else agJoined,
    cmdLeaveCall' = if (not(agWanted)) true else cmdLeaveCall,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 7. Gateway receives Command::LeaveCall or sees ParticipantLeft.
  action gwBeginLeave: bool = all {
    (cmdLeaveCall and (gwCallState == "joining" or gwCallState == "inCall"))
      or (gwCallState == "inCall" and not(userInCall)),
    cmdLeaveCall' = if (cmdLeaveCall) false else cmdLeaveCall,
    gwCallState' = "leaving",
    gwPlayQueue' = Set(),
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 7b. Gateway receives LeaveCall when already not in call (ignored).
  action gwIgnoreLeave: bool = all {
    cmdLeaveCall,
    gwCallState == "none" or gwCallState == "leaving",
    cmdLeaveCall' = false,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 8. Gateway finishes leaving, removes from rooms map, emits Event::CallLeft.
  action gwFinishLeave: bool = all {
    gwCallState == "leaving",
    gwCallState' = "none",
    evCallLeft' = evCallLeft + 1,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 9. Agent receives callLeft (updated src/call.ts): deletes room, resolves waiters,
  //    and immediately rejoins if agWanted is still true.
  action agRecvLeft: bool = all {
    evCallLeft > 0,
    evCallLeft' = evCallLeft - 1,
    val resolvesPlay = playState == "waitingSpoken" and playRoomGen == agRoomId and agSpokenWaiters.contains(playClipId)
    all {
      if (agWanted) all {
        agRoomId' = nextAgRoomId,
        nextAgRoomId' = nextAgRoomId + 1,
        cmdJoinCall' = true,
      } else all {
        agRoomId' = 0,
        nextAgRoomId' = nextAgRoomId,
        cmdJoinCall' = cmdJoinCall,
      },
      agJoined' = false,
      agSpokenWaiters' = Set(),
      playState' = if (resolvesPlay) "idle" else playState,
      playRoomGen' = if (resolvesPlay) 0 else playRoomGen,
      playClipId' = if (resolvesPlay) 0 else playClipId,
    },
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallSpoken' = evCallSpoken,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agWanted' = agWanted,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 10a. Agent #play starts writing WAV file.
  action agPlayStartWrite: bool = all {
    playState == "idle",
    agRoomId != 0,
    agJoined,
    playState' = "writingFile",
    playRoomGen' = agRoomId,
    playClipId' = nextClipId,
    nextClipId' = nextClipId + 1,
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 10b. Agent #play finishes writeFile: re-checks `this.#rooms.get(roomId) === room` before registering waiter.
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
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    evCallSpoken' = evCallSpoken,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    nextClipId' = nextClipId,
  }

  // 11. Gateway receives Command::CallSpeak.
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
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 12. Gateway finishes playing clip and emits CallSpoken.
  action gwFinishPlay(cid: int): bool = all {
    gwPlayQueue.contains(cid),
    gwPlayQueue' = gwPlayQueue.exclude(Set(cid)),
    evCallSpoken' = evCallSpoken.union(Set(cid)),
    userInCall' = userInCall,
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    agSpokenWaiters' = agSpokenWaiters,
    playState' = playState,
    playRoomGen' = playRoomGen,
    playClipId' = playClipId,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  // 13. Agent receives callSpoken.
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
    gwKnownInCall' = gwKnownInCall,
    gwCallState' = gwCallState,
    gwPlayQueue' = gwPlayQueue,
    evCallMembers' = evCallMembers,
    evCallJoined' = evCallJoined,
    evCallLeft' = evCallLeft,
    cmdJoinCall' = cmdJoinCall,
    cmdLeaveCall' = cmdLeaveCall,
    cmdCallSpeak' = cmdCallSpeak,
    agRoomId' = agRoomId,
    agWanted' = agWanted,
    nextAgRoomId' = nextAgRoomId,
    agJoined' = agJoined,
    nextClipId' = nextClipId,
    playHungOnDeadRoom' = playHungOnDeadRoom,
  }

  action step = any {
    userToggleCall(true),
    userToggleCall(false),
    gwEmitMembers,
    agRecvMembers,
    gwRecvJoin,
    gwFinishJoin,
    agRecvJoined,
    gwBeginLeave,
    gwIgnoreLeave,
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
      evCallMembers, evCallJoined, evCallLeft, evCallSpoken,
      cmdJoinCall, cmdLeaveCall, cmdCallSpeak,
      gwCallState, playState, userInCall, gwKnownInCall
    ) implies ((gwCallState == "inCall") == userInCall)

  val allInvariants: bool = invPlayNeverHangs and invMembershipConverges
}
