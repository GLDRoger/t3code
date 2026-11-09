package expo.modules.kinapprovalkey;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

public final class KinGrantVectors {
  public static void main(String[] args) throws Exception {
    List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
    long now = Long.parseLong(lines.get(0));
    int total = 0;
    int failures = 0;
    for (String line : lines.subList(1, lines.size())) {
      if (line.isEmpty()) continue;
      String[] fields = line.split("\t", -1);
      String actual;
      try {
        actual = KinGrant.prompt(fields[1], now);
      } catch (KinGrant.NotAGrantException error) {
        actual = "!E_NOT_A_GRANT";
      }
      total++;
      if (!actual.equals(fields[2])) {
        failures++;
        System.out.println("FAIL java: " + fields[0] + "\n  expected: " + fields[2] + "\n  actual:   " + actual);
      }
    }
    System.out.println("java: " + (total - failures) + "/" + total + " grant vectors pass");
    System.exit(failures == 0 ? 0 : 1);
  }
}
