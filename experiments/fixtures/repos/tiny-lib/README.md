# tiny-lib

Implement the failing functions in this repository so the provided test suite passes. Do not
modify the test files. Run `npm test` to check your work.

Three functions in `src/index.js` currently throw `not implemented`:

- `slugify(input)`: lowercases the input, turns runs of non-alphanumeric characters into a single
  hyphen, and trims leading and trailing hyphens. `slugify("Hello, World!") === "hello-world"`.
- `parseDuration(input)`: parses a duration string made of `<number><unit>` pairs, units `h`
  (hours), `m` (minutes), `s` (seconds), `ms` (milliseconds), and returns the total in
  milliseconds. `parseDuration("1h30m") === 5400000`. Invalid input throws `TypeError`.
- `groupBy(items, fn)`: groups an array into a plain object keyed by `String(fn(item))`, each key
  mapping to an array of the items in original order.

See `test/` for the exact expected behavior in each case.
