package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"time"

	"github.com/anishathalye/porcupine"
)

// A Line is one operation of a history, as the history spells it. The fields are these:
//   - client: the client that sent the operation, a whole number from 0.
//   - op: put, get or delete.
//   - key: the key of the operation.
//   - value: the value of a put, or the value that a get read. A get of a key with no value has
//     null, and a delete has no value.
//   - call and return: the times of the call and of the response, on one clock. The unit is free.
//   - result: ok, fail or unknown. A fail had no effect. An unknown operation had no response, thus
//     it can have an effect at each time after its call, and it has no return.
type Line struct {
	Client *int    `json:"client"`
	Op     string  `json:"op"`
	Key    *string `json:"key"`
	Value  *string `json:"value"`
	Call   *int64  `json:"call"`
	Return *int64  `json:"return"`
	Result string  `json:"result"`
}

// A register is the state of one key: its value, or no value.
type register struct {
	present bool
	value   string
}

// An input is an operation without its result.
type input struct {
	op    string
	key   string
	value string
}

// An output is the result of an operation. Only a get reads a value. An unknown output agrees with each state.
type output struct {
	present bool
	value   string
	unknown bool
}

// A History is the operations that the check uses. Dropped counts each failed operation and each
// unknown get: they have no effect. Unknown counts each unknown put or delete: each one is open to
// the end of the history.
type History struct {
	Operations []porcupine.Operation
	Dropped    int
	Unknown    int
}

// A fate tells what the check does with an operation.
type fate int

const (
	kept fate = iota
	dropped
	open
)

// Parse reads a history: one JSON line for each operation. Each field of a Line is required, except
// the value of a get or a delete and the return of an unknown operation. An unknown field is an error.
func Parse(reader io.Reader) (History, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1<<20)
	var history History
	var pending []porcupine.Operation
	var last int64
	number := 0
	for scanner.Scan() {
		number++
		text := bytes.TrimSpace(scanner.Bytes())
		if len(text) == 0 {
			continue
		}
		var line Line
		decoder := json.NewDecoder(bytes.NewReader(text))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&line); err != nil {
			return History{}, fmt.Errorf("line %d: %w", number, err)
		}
		operation, what, err := operationOf(line)
		if err != nil {
			return History{}, fmt.Errorf("line %d: %w", number, err)
		}
		if *line.Call > last {
			last = *line.Call
		}
		switch what {
		case dropped:
			history.Dropped++
		case open:
			history.Unknown++
			pending = append(pending, operation)
		default:
			if operation.Return > last {
				last = operation.Return
			}
			history.Operations = append(history.Operations, operation)
		}
	}
	if err := scanner.Err(); err != nil {
		return History{}, err
	}
	for _, operation := range pending {
		operation.Return = last + 1
		history.Operations = append(history.Operations, operation)
	}
	return history, nil
}

// operationOf checks one line and gives its operation and its fate.
func operationOf(line Line) (porcupine.Operation, fate, error) {
	var none porcupine.Operation
	if line.Client == nil || *line.Client < 0 {
		return none, kept, errors.New("client must be a whole number from 0")
	}
	if line.Key == nil {
		return none, kept, errors.New("key is missing")
	}
	if line.Call == nil {
		return none, kept, errors.New("call is missing")
	}
	switch line.Op {
	case "put":
		if line.Value == nil {
			return none, kept, errors.New("a put needs a value")
		}
	case "delete":
		if line.Value != nil {
			return none, kept, errors.New("a delete has no value")
		}
	case "get":
	default:
		return none, kept, fmt.Errorf("op %q is not put, get or delete", line.Op)
	}
	switch line.Result {
	case "ok", "fail":
		if line.Return == nil {
			return none, kept, errors.New("return is missing")
		}
		if *line.Return < *line.Call {
			return none, kept, errors.New("return is before call")
		}
	case "unknown":
		if line.Return != nil {
			return none, kept, errors.New("an unknown operation has no return")
		}
	default:
		return none, kept, fmt.Errorf("result %q is not ok, fail or unknown", line.Result)
	}
	in := input{op: line.Op, key: *line.Key}
	if line.Op == "put" {
		in.value = *line.Value
	}
	if line.Result == "fail" || (line.Result == "unknown" && line.Op == "get") {
		return none, dropped, nil
	}
	var operation porcupine.Operation
	operation.ClientId = *line.Client
	operation.Input = in
	operation.Call = *line.Call
	if line.Result == "unknown" {
		operation.Output = output{unknown: true}
		return operation, open, nil
	}
	out := output{}
	if line.Op == "get" && line.Value != nil {
		out = output{present: true, value: *line.Value}
	}
	operation.Output = out
	operation.Return = *line.Return
	return operation, kept, nil
}

// step is the sequential law of a register: a get reads the last put, or no value after a delete.
func step(state, in, out interface{}) (bool, interface{}) {
	current := state.(register)
	operation := in.(input)
	result := out.(output)
	switch operation.op {
	case "get":
		return result.unknown || (result.present == current.present && result.value == current.value), current
	case "put":
		return true, register{present: true, value: operation.value}
	default:
		return true, register{}
	}
}

// describe gives an operation in words, for the visualization.
func describe(in, out interface{}) string {
	operation := in.(input)
	result := out.(output)
	switch {
	case operation.op == "put":
		return fmt.Sprintf("put(%q, %q)", operation.key, operation.value)
	case operation.op == "delete":
		return fmt.Sprintf("delete(%q)", operation.key)
	case !result.present:
		return fmt.Sprintf("get(%q) -> none", operation.key)
	default:
		return fmt.Sprintf("get(%q) -> %q", operation.key, result.value)
	}
}

// describeState gives a state in words, for the visualization.
func describeState(state interface{}) string {
	current := state.(register)
	if !current.present {
		return "none"
	}
	return fmt.Sprintf("%q", current.value)
}

// split gives the keys of a history in order, and the operations of each key.
func split(history []porcupine.Operation) ([]string, [][]porcupine.Operation) {
	groups := map[string][]porcupine.Operation{}
	for _, operation := range history {
		key := operation.Input.(input).key
		groups[key] = append(groups[key], operation)
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([][]porcupine.Operation, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, groups[key])
	}
	return keys, parts
}

// byKey is the partition of the model: a history is linearizable if the history of each key is.
func byKey(history []porcupine.Operation) [][]porcupine.Operation {
	_, parts := split(history)
	return parts
}

// modelOf gives the model of a store of registers. With partition, the model checks each key apart.
func modelOf(partition bool) porcupine.Model {
	var model porcupine.Model
	if partition {
		model.Partition = byKey
	}
	model.Init = func() interface{} { return register{} }
	model.Step = step
	model.DescribeOperation = describe
	model.DescribeState = describeState
	return model
}

// A Verdict is the result of a check, as one JSON line. Illegal names each key whose history is not
// linearizable, and Undecided each key whose check reached the timeout.
type Verdict struct {
	Ev         string   `json:"ev"`
	Result     string   `json:"result"`
	Operations int      `json:"operations"`
	Keys       int      `json:"keys"`
	Illegal    []string `json:"illegal"`
	Undecided  []string `json:"undecided"`
	Dropped    int      `json:"dropped"`
	Unknown    int      `json:"unknown"`
}

// Check checks the history of each key, each within the timeout. A timeout of 0 has no limit.
// The result is Illegal if a key is illegal, then Unknown if a key is undecided, then Ok.
func Check(history History, timeout time.Duration) Verdict {
	keys, parts := split(history.Operations)
	verdict := Verdict{Ev: "checked", Result: string(porcupine.Ok), Operations: len(history.Operations), Keys: len(keys), Illegal: []string{}, Undecided: []string{}, Dropped: history.Dropped, Unknown: history.Unknown}
	model := modelOf(false)
	for at, part := range parts {
		switch porcupine.CheckOperationsTimeout(model, part, timeout) {
		case porcupine.Illegal:
			verdict.Illegal = append(verdict.Illegal, keys[at])
		case porcupine.Unknown:
			verdict.Undecided = append(verdict.Undecided, keys[at])
		}
	}
	if len(verdict.Illegal) > 0 {
		verdict.Result = string(porcupine.Illegal)
	} else if len(verdict.Undecided) > 0 {
		verdict.Result = string(porcupine.Unknown)
	}
	return verdict
}
