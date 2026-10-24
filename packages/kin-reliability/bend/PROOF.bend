import Base
import ./lane.bend as Lane
import ./LAWS.bend as Laws

def Laws.reviewer_never_crowned(phase, will):
  match phase:
    case Lane.Proposed{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.Running{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.AwaitingWill{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.WillMissing{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.Gated{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.Crowned{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.Failed{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}

def Laws.no_crown_without_will(phase, role):
  match phase:
    case Lane.Proposed{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.Running{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.AwaitingWill{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.WillMissing{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.Gated{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.Crowned{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}
    case Lane.Failed{}:
      match role:
        case Lane.Author{}:
          {==}
        case Lane.Reviewer{}:
          {==}

def Laws.will_missing_not_crowned(role, will):
  match role:
    case Lane.Author{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}
    case Lane.Reviewer{}:
      match will:
        case Lane.Absent{}:
          {==}
        case Lane.Present{}:
          {==}

def Laws.author_gate_crowns():
  {==}

def Laws.crown_idempotent():
  {==}

def Laws.duplicate_is_identity(phase, role, will):
  match phase:
    case Lane.Proposed{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Running{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.AwaitingWill{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.WillMissing{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Gated{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Crowned{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Failed{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}

def Laws.step_crown_agrees(phase, role, will):
  match phase:
    case Lane.Proposed{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Running{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.AwaitingWill{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.WillMissing{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Gated{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Crowned{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
    case Lane.Failed{}:
      match role:
        case Lane.Author{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}
        case Lane.Reviewer{}:
          match will:
            case Lane.Absent{}:
              {==}
            case Lane.Present{}:
              {==}

def Laws.fail_keeps_crowned():
  {==}

def Laws.regnal_is_successor(n):
  {==}
