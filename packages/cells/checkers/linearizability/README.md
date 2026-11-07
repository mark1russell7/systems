# The checker of linearizability

This program checks a history of a key-value store for linearizability. The solver is [Porcupine](https://github.com/anishathalye/porcupine) v1.3.1, under the MIT License.

The program reads the history on stdin, one JSON line for each operation. It prints one JSON line with the result. The model is a register for each key, thus the program checks each key apart.

```sh
go build -o linearizability . && ./linearizability -timeout 1m < history.jsonl
```

## The history

Each line has these fields:

| Field | Value |
| --- | --- |
| `client` | The client of the operation, a whole number from 0 |
| `op` | `put`, `get` or `delete` |
| `key` | The key of the operation |
| `value` | The value of a put, or the value that a get read: `null` for a key with no value. A delete has no value. |
| `call`, `return` | The times of the call and of the response, on one clock |
| `result` | `ok`, `fail` or `unknown` |

- A failed operation had no effect. The check does not use it.
- An unknown operation got no response. It has no `return`, and it can take effect at each time after its call. The check does not use an unknown get.
- An interval is closed: two operations that touch at one time are concurrent.

## The result

```json
{"ev":"checked","result":"Illegal","operations":3,"keys":1,"illegal":["x"],"undecided":[],"dropped":0,"unknown":0}
```

- `result` is `Ok`, `Illegal` or `Unknown`. `Unknown` tells that the check of a key reached the timeout.
- `illegal` names each key with no linearization, and `undecided` each key at the timeout.
- `dropped` counts the operations that the check does not use, and `unknown` counts the open writes.

The exit code is 0 for `Ok` and 1 for `Illegal` or `Unknown`. A history or an option that the program refuses gives 2. The option `-visualize <path>` writes the HTML page of Porcupine for the whole history.

## Its place

The program imports nothing from this repository, thus it can move whole. Its home is the checker of histories in `mark1russell7/rigor`. The CI of this repository runs its format check, its vet and its tests with the Go of the images of the harness.
