package expo.modules.kinapprovalkey;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Parses a KinGrant JWS signing input (docs/kin/specs/approvals.md, section 5) and builds the
 * approval prompt from it. Pure JDK so it compiles and runs without an Android SDK; it must
 * accept and reject exactly what ios/KinGrant.swift does (fixtures/grant-vectors.json).
 */
final class KinGrant {
  static final class NotAGrantException extends Exception {
    NotAGrantException(String reason) {
      super(reason);
    }
  }

  private static final int MAX_SIGNING_INPUT = 8192;
  private static final int MAX_DEPTH = 3;
  private static final int MAX_PROMPT_CHARS = 200;
  private static final int SHOWN_HASH_LENGTH = 16;
  private static final long MAX_SAFE_INTEGER = 9007199254740991L;
  private static final long MAX_LIFETIME_SECONDS = 900;
  private static final long MAX_CLOCK_SKEW_SECONDS = 300;

  private static final Pattern SHA40 = Pattern.compile("[0-9a-f]{40}");
  private static final Pattern HEX64 = Pattern.compile("[0-9a-f]{64}");
  private static final Pattern REPO = Pattern.compile("[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}");
  // What a shown value may contain. ASCII only, so no platform Unicode table is consulted and
  // nothing invisible, confusable or reordering can reach the prompt; a quote can't occur.
  /** Branch names and paths: letters, digits and {@code . _ - / +} (a subset of what git allows). */
  private static final Pattern NAME = Pattern.compile("[A-Za-z0-9._/+-]+");
  /** Lead and chat ids: letters, digits and {@code . _ -}. */
  private static final Pattern ID = Pattern.compile("[A-Za-z0-9._-]+");
  private static final Pattern THUMBPRINT = Pattern.compile("[A-Za-z0-9_-]{43}");

  private static final Set<String> PAYLOAD_REQUIRED = setOf(
      "v", "orgId", "actionId", "revision", "nonce", "jti", "kind", "targetDigest", "target",
      "approver", "decision", "iat", "exp");

  private KinGrant() {}

  /** Returns the prompt text for a valid grant signing input, or throws NotAGrantException. */
  static String prompt(String signingInput, long nowSeconds) throws NotAGrantException {
    if (signingInput.isEmpty() || signingInput.length() > MAX_SIGNING_INPUT) {
      throw new NotAGrantException("signing input is empty or too long");
    }
    int dot = signingInput.indexOf('.');
    if (dot < 0 || signingInput.indexOf('.', dot + 1) >= 0) {
      throw new NotAGrantException("signing input is not header.payload");
    }
    Map<String, Object> header = object(signingInput.substring(0, dot), "header");
    Map<String, Object> payload = object(signingInput.substring(dot + 1), "payload");
    checkHeader(header);
    return promptFor(payload, (String) header.get("kid"), nowSeconds);
  }

  private static Map<String, Object> object(String segment, String label) throws NotAGrantException {
    String json = utf8(base64UrlDecode(segment, label), label);
    Object value = new Parser(json).parseDocument();
    if (!(value instanceof Map)) throw new NotAGrantException(label + " is not an object");
    @SuppressWarnings("unchecked")
    Map<String, Object> map = (Map<String, Object>) value;
    return map;
  }

  private static void checkHeader(Map<String, Object> header) throws NotAGrantException {
    exactKeys(header, setOf("alg", "kid", "typ"), setOf(), "header");
    if (!"ES256".equals(header.get("alg"))) throw new NotAGrantException("alg is not ES256");
    if (!"kin-grant+jws".equals(header.get("typ"))) throw new NotAGrantException("typ is not kin-grant+jws");
    nonEmpty(header, "kid");
  }

  private static String promptFor(Map<String, Object> p, String kid, long now) throws NotAGrantException {
    exactKeys(p, PAYLOAD_REQUIRED, setOf("headSha", "base", "mergeMethod"), "payload");
    if (integer(p, "v") != 1) throw new NotAGrantException("v is not 1");
    if (!"approve".equals(p.get("decision"))) throw new NotAGrantException("decision is not approve");
    for (String key : new String[] {"orgId", "actionId", "nonce", "jti"}) nonEmpty(p, key);
    if (integer(p, "revision") < 0) throw new NotAGrantException("revision is negative");
    matches(p, "targetDigest", HEX64);
    Map<String, Object> approver = child(p, "approver");
    exactKeys(approver, setOf("humanId", "kid"), setOf(), "approver");
    nonEmpty(approver, "humanId");
    if (!string(approver, "kid").equals(kid)) throw new NotAGrantException("approver.kid is not the header kid");

    long iat = integer(p, "iat");
    long exp = integer(p, "exp");
    if (exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) throw new NotAGrantException("exp is outside iat + 900");
    if (Math.abs(now - iat) > MAX_CLOCK_SKEW_SECONDS) throw new NotAGrantException("iat is not now");

    Map<String, Object> target = child(p, "target");
    String kind = string(p, "kind");
    String text;
    switch (kind) {
      case "merge_pull_request": {
        only(p, "headSha", "base", "mergeMethod");
        pullRequestTarget(target);
        String method = string(p, "mergeMethod");
        if (!method.equals(target.get("mergeMethod"))) throw new NotAGrantException("mergeMethod differs from target");
        text = "Merge " + target.get("repo") + " #" + target.get("number") + " (" + headSha(p) + ") into \""
            + shown(p, "base", NAME) + "\" " + methodWords(method)
            + (Boolean.TRUE.equals(target.get("deleteBranchAfter")) ? ", then delete its branch" : "");
        break;
      }
      case "delete_branch": {
        only(p, "headSha");
        exactKeys(target, setOf("_tag", "host", "repo", "ref"), setOf(), "target");
        tag(target, "branch");
        githubRepo(target);
        text = "Delete branch \"" + shown(target, "ref", NAME) + "\" (" + headSha(p) + ") in " + target.get("repo");
        break;
      }
      case "set_level": {
        only(p);
        exactKeys(target, setOf("_tag", "leadId", "level"), setOf("chatId"), "target");
        tag(target, "level");
        String level = string(target, "level");
        if (!level.matches("L[0-3]")) throw new NotAGrantException("level is not L0-L3");
        String chat =
            target.containsKey("chatId") ? " in chat \"" + shown(target, "chatId", ID) + "\"" : " in all chats";
        text = "Set lead \"" + shown(target, "leadId", ID) + "\" to " + level + chat;
        break;
      }
      case "change_rules":
      case "memory_purge": {
        only(p);
        exactKeys(target, setOf("_tag", "path", "sha256"), setOf(), "target");
        tag(target, "content");
        String hash = matches(target, "sha256", HEX64).substring(0, SHOWN_HASH_LENGTH);
        String path = shown(target, "path", NAME);
        text = kind.equals("change_rules")
            ? "Change rules to \"" + path + "\" (sha256 " + hash + ")"
            : "Purge memory using \"" + path + "\" (sha256 " + hash + ")";
        break;
      }
      case "register_approver_key": {
        only(p);
        exactKeys(target, setOf("_tag", "thumbprint", "hardware", "attested"), setOf(), "target");
        tag(target, "device_key");
        String thumbprint = matches(target, "thumbprint", THUMBPRINT);
        // The server never activates an unattested key, so there is nothing to approve for one.
        if (!Boolean.TRUE.equals(target.get("attested"))) throw new NotAGrantException("the key is not attested");
        text = "Add approver key " + thumbprint.substring(0, SHOWN_HASH_LENGTH)
            + " (" + hardwareWords(string(target, "hardware")) + ", attested)";
        break;
      }
      default:
        throw new NotAGrantException("kind has no prompt template");
    }
    // Refused rather than cut, so the fixed words after a long value always show.
    if (text.length() > MAX_PROMPT_CHARS) throw new NotAGrantException("the prompt is over 200 characters");
    return text;
  }

  private static void pullRequestTarget(Map<String, Object> target) throws NotAGrantException {
    exactKeys(target, setOf("_tag", "host", "repo", "number", "mergeMethod", "deleteBranchAfter"), setOf(), "target");
    tag(target, "pull_request");
    githubRepo(target);
    if (integer(target, "number") < 1) throw new NotAGrantException("number is not positive");
    if (!(target.get("deleteBranchAfter") instanceof Boolean)) {
      throw new NotAGrantException("deleteBranchAfter is not a boolean");
    }
  }

  private static void githubRepo(Map<String, Object> target) throws NotAGrantException {
    if (!"github.com".equals(target.get("host"))) throw new NotAGrantException("host is not github.com");
    matches(target, "repo", REPO);
  }

  private static String hardwareWords(String hardware) throws NotAGrantException {
    switch (hardware) {
      case "secure_enclave":
        return "Secure Enclave";
      case "strongbox":
        return "StrongBox";
      case "tee":
        return "TEE";
      default:
        throw new NotAGrantException("hardware is not secure_enclave, strongbox or tee");
    }
  }

  private static String methodWords(String method) throws NotAGrantException {
    switch (method) {
      case "merge":
        return "with a merge commit";
      case "squash":
        return "by squashing";
      case "rebase":
        return "by rebasing";
      default:
        throw new NotAGrantException("mergeMethod is unknown");
    }
  }

  private static String headSha(Map<String, Object> p) throws NotAGrantException {
    return matches(p, "headSha", SHA40).substring(0, SHOWN_HASH_LENGTH);
  }

  /** The optional payload fields allowed for this kind; any other optional field is refused. */
  private static void only(Map<String, Object> p, String... allowed) throws NotAGrantException {
    Set<String> allow = setOf(allowed);
    for (String key : new String[] {"headSha", "base", "mergeMethod"}) {
      if (p.containsKey(key) && !allow.contains(key)) throw new NotAGrantException(key + " is not allowed here");
    }
    for (String key : allow) {
      if (!p.containsKey(key)) throw new NotAGrantException(key + " is required");
    }
  }

  private static void tag(Map<String, Object> target, String expected) throws NotAGrantException {
    if (!expected.equals(target.get("_tag"))) throw new NotAGrantException("target is not " + expected);
  }

  private static void exactKeys(Map<String, Object> map, Set<String> required, Set<String> optional, String label)
      throws NotAGrantException {
    for (String key : required) {
      if (!map.containsKey(key)) throw new NotAGrantException(label + "." + key + " is missing");
    }
    for (String key : map.keySet()) {
      if (!required.contains(key) && !optional.contains(key)) {
        throw new NotAGrantException(label + "." + key + " is not allowed");
      }
    }
  }

  private static String string(Map<String, Object> map, String key) throws NotAGrantException {
    Object value = map.get(key);
    if (!(value instanceof String)) throw new NotAGrantException(key + " is not a string");
    return (String) value;
  }

  private static void nonEmpty(Map<String, Object> map, String key) throws NotAGrantException {
    if (string(map, key).isEmpty()) throw new NotAGrantException(key + " is empty");
  }

  private static String matches(Map<String, Object> map, String key, Pattern pattern) throws NotAGrantException {
    String value = string(map, key);
    if (!pattern.matcher(value).matches()) throw new NotAGrantException(key + " is malformed");
    return value;
  }

  private static long integer(Map<String, Object> map, String key) throws NotAGrantException {
    Object value = map.get(key);
    if (!(value instanceof Long)) throw new NotAGrantException(key + " is not an integer");
    return (Long) value;
  }

  private static Map<String, Object> child(Map<String, Object> map, String key) throws NotAGrantException {
    Object value = map.get(key);
    if (!(value instanceof Map)) throw new NotAGrantException(key + " is not an object");
    @SuppressWarnings("unchecked")
    Map<String, Object> child = (Map<String, Object>) value;
    return child;
  }

  /** A shown value, refused (never cleaned) if it is empty or has a character outside its allowlist. */
  private static String shown(Map<String, Object> map, String key, Pattern allowed) throws NotAGrantException {
    String value = string(map, key);
    if (!allowed.matcher(value).matches()) throw new NotAGrantException(key + " has a character that can't be shown");
    return value;
  }

  private static Set<String> setOf(String... values) {
    return new HashSet<>(Arrays.asList(values));
  }

  private static final String ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  /** Unpadded base64url with zero trailing bits, so every byte string has exactly one encoding. */
  static byte[] base64UrlDecode(String value, String label) throws NotAGrantException {
    if (value.isEmpty() || value.length() % 4 == 1) throw new NotAGrantException(label + " is not base64url");
    byte[] out = new byte[value.length() * 3 / 4];
    int buffer = 0;
    int bits = 0;
    int index = 0;
    for (int i = 0; i < value.length(); i++) {
      int digit = ALPHABET.indexOf(value.charAt(i));
      if (digit < 0) throw new NotAGrantException(label + " is not base64url");
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[index++] = (byte) (buffer >> bits);
        buffer &= (1 << bits) - 1;
      }
    }
    if (buffer != 0) throw new NotAGrantException(label + " has non-zero trailing bits");
    return out;
  }

  private static String utf8(byte[] bytes, String label) throws NotAGrantException {
    try {
      return StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
    } catch (CharacterCodingException error) {
      throw new NotAGrantException(label + " is not UTF-8");
    }
  }

  /**
   * Accepts only the canonical form stableStringify (packages/shared/src/relaySigning.ts) writes:
   * no whitespace, keys in strictly increasing UTF-16 order (so no duplicates), JSON.stringify's
   * string escapes, safe integers. Only objects, strings, integers and booleans occur in a grant.
   */
  private static final class Parser {
    private final String text;
    private int at;

    Parser(String text) {
      this.text = text;
    }

    Object parseDocument() throws NotAGrantException {
      Object value = parseValue(0);
      if (at != text.length()) fail("trailing characters");
      return value;
    }

    private Object parseValue(int depth) throws NotAGrantException {
      if (at >= text.length()) fail("unexpected end");
      char c = text.charAt(at);
      if (c == '{') return parseObject(depth);
      if (c == '"') return parseString();
      if (c == '-' || (c >= '0' && c <= '9')) return parseInteger();
      if (text.startsWith("true", at)) {
        at += 4;
        return Boolean.TRUE;
      }
      if (text.startsWith("false", at)) {
        at += 5;
        return Boolean.FALSE;
      }
      fail("unsupported value");
      return null;
    }

    private Map<String, Object> parseObject(int depth) throws NotAGrantException {
      if (depth >= MAX_DEPTH) fail("nested too deep");
      at++;
      Map<String, Object> map = new LinkedHashMap<>();
      if (peek('}')) {
        at++;
        return map;
      }
      String previous = null;
      while (true) {
        if (!peek('"')) fail("expected a key");
        String key = parseString();
        if (previous != null && previous.compareTo(key) >= 0) fail("keys are not in canonical order");
        previous = key;
        expect(':');
        map.put(key, parseValue(depth + 1));
        if (peek(',')) {
          at++;
          continue;
        }
        expect('}');
        return map;
      }
    }

    private String parseString() throws NotAGrantException {
      at++;
      StringBuilder out = new StringBuilder();
      while (true) {
        if (at >= text.length()) fail("unterminated string");
        char c = text.charAt(at++);
        if (c == '"') return out.toString();
        if (c < 0x20) fail("raw control character");
        if (c != '\\') {
          out.append(c);
          continue;
        }
        if (at >= text.length()) fail("unterminated escape");
        char e = text.charAt(at++);
        switch (e) {
          case '"': out.append('"'); break;
          case '\\': out.append('\\'); break;
          case 'b': out.append('\b'); break;
          case 'f': out.append('\f'); break;
          case 'n': out.append('\n'); break;
          case 'r': out.append('\r'); break;
          case 't': out.append('\t'); break;
          case 'u': out.append(parseControlEscape()); break;
          default: fail("non-canonical escape");
        }
      }
    }

    // JSON.stringify only writes \\u for control characters without a short escape (and lone
    // surrogates, which a grant never contains), always as lowercase \\u00xx.
    private char parseControlEscape() throws NotAGrantException {
      if (at + 4 > text.length() || !text.startsWith("00", at)) fail("non-canonical \\u escape");
      String hex = text.substring(at + 2, at + 4);
      if (!hex.matches("[01][0-9a-f]")) fail("non-canonical \\u escape");
      char c = (char) Integer.parseInt(hex, 16);
      if (c == '\b' || c == '\t' || c == '\n' || c == '\f' || c == '\r') fail("non-canonical \\u escape");
      at += 4;
      return c;
    }

    private Long parseInteger() throws NotAGrantException {
      int start = at;
      if (peek('-')) at++;
      if (peek('0')) {
        at++;
      } else {
        if (at >= text.length() || text.charAt(at) < '1' || text.charAt(at) > '9') fail("bad number");
        while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') at++;
      }
      if (at < text.length() && (text.charAt(at) == '.' || text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
        fail("not an integer");
      }
      String digits = text.substring(start, at);
      if (digits.equals("-0")) fail("negative zero");
      if (digits.length() > 17) fail("integer out of range");
      long value = Long.parseLong(digits);
      if (Math.abs(value) > MAX_SAFE_INTEGER) fail("integer out of range");
      return value;
    }

    private boolean peek(char c) {
      return at < text.length() && text.charAt(at) == c;
    }

    private void expect(char c) throws NotAGrantException {
      if (!peek(c)) fail("expected " + c);
      at++;
    }

    private void fail(String reason) throws NotAGrantException {
      throw new NotAGrantException("not canonical JSON: " + reason);
    }
  }
}
