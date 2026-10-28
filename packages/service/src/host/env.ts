/** An env file is the variables of a file of environment variables, and the problem of each line that it skipped. */
export interface EnvFile {
  readonly env: Readonly<Record<string, string>>;
  readonly problems: readonly string[];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** This function reads a value in double quotes: `\n`, `\t`, `\"` and `\\` are escapes. */
const doubleQuoted = (body: string): string =>
  body.replace(/\\(.)/g, (_match, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char === "r" ? "\r" : char));

/**
 * This function reads a file of environment variables, one `KEY=value` on each line. It is a pure
 * function. It does not throw: it skips a bad line and gives its problem.
 * - A blank line and a line that starts with `#` are skipped. A line can start with `export `.
 * - A value in single quotes is literal. A value in double quotes has the escapes `\n`, `\t`, `\"` and `\\`.
 * - A value without quotes ends at ` #`, and its spaces at the two ends go.
 * - A key that comes again replaces its value.
 */
export const parseEnvFile = (text: string): EnvFile => {
  const env: Record<string, string> = {};
  const problems: string[] = [];
  // a byte order mark at the start is not a part of the first key
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, at) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const equals = body.indexOf("=");
    if (equals <= 0) {
      problems.push(`line ${at + 1} has no KEY=value`);
      return;
    }
    const key = body.slice(0, equals).trim();
    if (!KEY.test(key)) {
      problems.push(`line ${at + 1}: ${JSON.stringify(key)} is not a name of a variable`);
      return;
    }
    const rest = body.slice(equals + 1).trim();
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      const end = quote === "'" ? rest.indexOf("'", 1) : closingQuote(rest);
      if (end < 0) {
        problems.push(`line ${at + 1}: the value of ${key} has no closing quote`);
        return;
      }
      env[key] = quote === "'" ? rest.slice(1, end) : doubleQuoted(rest.slice(1, end));
      return;
    }
    const comment = rest.search(/\s#/);
    env[key] = (comment < 0 ? rest : rest.slice(0, comment)).trim();
  });
  return { env, problems };
};

/** This function gives the place of the double quote that closes a value, or -1. A quote after a backslash does not close it. */
const closingQuote = (text: string): number => {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === '"') return at;
  }
  return -1;
};
