/** "1 task", "3 tasks": a count and its word; `many` is `one` with an "s" unless given. */
export const kinCount = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
