import Foundation

let lines = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
  .split(separator: "\n", omittingEmptySubsequences: true)
guard let now = Int64(lines[0]) else { fatalError("The first line must be the vectors' clock.") }
var failures = 0
for line in lines.dropFirst() {
  let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
  let (name, signingInput, expected) = (fields[0], fields[1], fields[2])
  let actual: String
  do {
    actual = try KinGrant.prompt(signingInput: signingInput, now: now)
  } catch {
    actual = "!E_NOT_A_GRANT"
  }
  if actual != expected {
    failures += 1
    print("FAIL swift: \(name)\n  expected: \(expected)\n  actual:   \(actual)")
  }
}
print("swift: \(lines.count - 1 - failures)/\(lines.count - 1) grant vectors pass")
exit(failures == 0 ? 0 : 1)
