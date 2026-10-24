import Base

# Lane state machine for Kin reliability.
# State names follow DESIGN.md section 13. Lane 2 (lineage-core) owns the
# authoritative machine; this model is the contract kin verify proves against.
# Binders are matched in parameter order. Move is not named Event: Bend's
# Base already declares that name.

type Phase is Data:
  Proposed{}
  Running{}
  AwaitingWill{}
  WillMissing{}
  Gated{}
  Crowned{}
  Failed{}

type Role is Data:
  Author{}
  Reviewer{}

type Will is Data:
  Absent{}
  Present{}

type Move is Data:
  Start{}
  FinishWork{}
  RecordWill{}
  MissWill{}
  EnterGate{}
  Crown{}
  MarkFailed{}
  Duplicate{}

def next_regnal(n: Nat) -> Nat:
  1n+n

def not_crowned(phase: Phase) -> Bool:
  match phase:
    case Proposed{}: True{}
    case Running{}: True{}
    case AwaitingWill{}: True{}
    case WillMissing{}: True{}
    case Gated{}: True{}
    case Crowned{}: False{}
    case Failed{}: True{}

def crown(phase: Phase, role: Role, will: Will) -> Phase:
  match phase:
    case Proposed{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: Proposed{}
            case Present{}: Proposed{}
        case Reviewer{}:
          match will:
            case Absent{}: Proposed{}
            case Present{}: Proposed{}
    case Running{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: Running{}
            case Present{}: Running{}
        case Reviewer{}:
          match will:
            case Absent{}: Running{}
            case Present{}: Running{}
    case AwaitingWill{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: AwaitingWill{}
            case Present{}: AwaitingWill{}
        case Reviewer{}:
          match will:
            case Absent{}: AwaitingWill{}
            case Present{}: AwaitingWill{}
    case WillMissing{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: WillMissing{}
            case Present{}: WillMissing{}
        case Reviewer{}:
          match will:
            case Absent{}: WillMissing{}
            case Present{}: WillMissing{}
    case Gated{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: Gated{}
            case Present{}: Crowned{}
        case Reviewer{}:
          match will:
            case Absent{}: Gated{}
            case Present{}: Gated{}
    case Crowned{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: Crowned{}
            case Present{}: Crowned{}
        case Reviewer{}:
          match will:
            case Absent{}: Crowned{}
            case Present{}: Crowned{}
    case Failed{}:
      match role:
        case Author{}:
          match will:
            case Absent{}: Failed{}
            case Present{}: Failed{}
        case Reviewer{}:
          match will:
            case Absent{}: Failed{}
            case Present{}: Failed{}

def step(phase: Phase, move: Move, role: Role, will: Will) -> Phase:
  match phase:
    case Proposed{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
            case Reviewer{}:
              match will:
                case Absent{}: Proposed{}
                case Present{}: Proposed{}
    case Running{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
            case Reviewer{}:
              match will:
                case Absent{}: Running{}
                case Present{}: Running{}
    case AwaitingWill{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: AwaitingWill{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: Gated{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
            case Reviewer{}:
              match will:
                case Absent{}: AwaitingWill{}
                case Present{}: AwaitingWill{}
    case WillMissing{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: Gated{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
            case Reviewer{}:
              match will:
                case Absent{}: WillMissing{}
                case Present{}: WillMissing{}
    case Gated{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
            case Reviewer{}:
              match will:
                case Absent{}: Gated{}
                case Present{}: Gated{}
    case Crowned{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
            case Reviewer{}:
              match will:
                case Absent{}: Crowned{}
                case Present{}: Crowned{}
    case Failed{}:
      match move:
        case Start{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case FinishWork{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case RecordWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case MissWill{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case EnterGate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Crown{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case MarkFailed{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
        case Duplicate{}:
          match role:
            case Author{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
            case Reviewer{}:
              match will:
                case Absent{}: Failed{}
                case Present{}: Failed{}
