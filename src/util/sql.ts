/**
 * Escapes SQL `LIKE` wildcard metacharacters (`%`, `_`, `\`) in user
 * input so they match as literal characters rather than patterns.
 *
 * Use together with `LIKE ? ESCAPE '\'` in the SQL statement. Both
 * halves are required — escaping without the `ESCAPE` clause is a
 * no-op, and the `ESCAPE` clause without escaping does nothing useful.
 *
 * Example:
 *   const needle = `%${escapeLike(input.q)}%`;
 *   db.prepare("SELECT * FROM t WHERE name LIKE ? ESCAPE '\\'").all(needle);
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}
