import Base
import ./lane.bend as Lane

# Crown guards. These are the V2 laws for the lane state machine.
# A reviewer is never newly distinguished from its phase by Crown.
law reviewer_never_crowned:
  for phase: Lane.Phase
  for will: Lane.Will
  {Lane.crown(phase, Lane.Reviewer{}, will) == phase : Lane.Phase}

# Crown with no will leaves the phase unchanged.
law no_crown_without_will:
  for phase: Lane.Phase
  for role: Lane.Role
  {Lane.crown(phase, role, Lane.Absent{}) == phase : Lane.Phase}

# WillMissing does not become Crowned by the Crown move, will or not.
law will_missing_not_crowned:
  for role: Lane.Role
  for will: Lane.Will
  {Lane.crown(Lane.WillMissing{}, role, will) == Lane.WillMissing{} : Lane.Phase}

# The one crown that should succeed.
law author_gate_crowns:
  {Lane.crown(Lane.Gated{}, Lane.Author{}, Lane.Present{}) == Lane.Crowned{} : Lane.Phase}

# Crowning an already crowned author is idempotent.
law crown_idempotent:
  {Lane.crown(Lane.Crowned{}, Lane.Author{}, Lane.Present{}) == Lane.Crowned{} : Lane.Phase}

# A duplicate move does not change the phase.
law duplicate_is_identity:
  for phase: Lane.Phase
  for role: Lane.Role
  for will: Lane.Will
  {Lane.step(phase, Lane.Duplicate{}, role, will) == phase : Lane.Phase}

# The Crown move agrees with crown.
law step_crown_agrees:
  for phase: Lane.Phase
  for role: Lane.Role
  for will: Lane.Will
  {Lane.step(phase, Lane.Crown{}, role, will) == Lane.crown(phase, role, will) : Lane.Phase}

# Failure does not uncrown.
law fail_keeps_crowned:
  {Lane.step(Lane.Crowned{}, Lane.MarkFailed{}, Lane.Author{}, Lane.Present{}) == Lane.Crowned{} : Lane.Phase}

# Regnal numbers are the successor of the previous number in the house.
law regnal_is_successor:
  for n: Nat
  {Lane.next_regnal(n) == 1n+n : Nat}
